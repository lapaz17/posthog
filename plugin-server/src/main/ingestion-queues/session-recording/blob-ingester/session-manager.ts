import { Upload } from '@aws-sdk/lib-storage'
import { captureException, captureMessage } from '@sentry/node'
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, WriteStream } from 'fs'
import { readFile, stat, unlink } from 'fs/promises'
import { DateTime } from 'luxon'
import path from 'path'
import { Counter, Histogram } from 'prom-client'
import * as zlib from 'zlib'

import { PluginsServerConfig } from '../../../../types'
import { asyncTimeoutGuard, timeoutGuard } from '../../../../utils/db/utils'
import { status } from '../../../../utils/status'
import { ObjectStorage } from '../../../services/object_storage'
import { bufferFileDir } from '../session-recordings-blob-consumer'
import { RealtimeManager } from './realtime-manager'
import { IncomingRecordingMessage } from './types'
import { convertToPersistedMessage, now } from './utils'

const counterS3FilesWritten = new Counter({
    name: 'recording_s3_files_written',
    help: 'A single file flushed to S3',
    labelNames: ['flushReason'],
})

const counterS3WriteErrored = new Counter({
    name: 'recording_s3_write_errored',
    help: 'Indicates that we failed to flush to S3 without recovering',
})

const histogramS3LinesWritten = new Histogram({
    name: 'recording_s3_lines_written_histogram',
    help: 'The number of lines in a file we send to s3',
    buckets: [0, 10, 50, 100, 500, 1000, 2000, 5000, 10000, Infinity],
})

const histogramS3KbWritten = new Histogram({
    name: 'recording_blob_ingestion_s3_kb_written',
    help: 'The uncompressed size of file we send to S3',
    buckets: [0, 128, 512, 1024, 2048, 5120, 10240, 20480, 51200, 102400, Infinity],
})

const histogramSessionAgeSeconds = new Histogram({
    name: 'recording_blob_ingestion_session_age_seconds',
    help: 'The age of current sessions in seconds',
    buckets: [0, 60, 60 * 2, 60 * 5, 60 * 8, 60 * 10, 60 * 12, 60 * 15, 60 * 20, Infinity],
})

const histogramSessionSizeKb = new Histogram({
    name: 'recording_blob_ingestion_session_size_kb',
    help: 'The size of current sessions in kb',
    buckets: [0, 128, 512, 1024, 2048, 5120, 10240, 20480, 51200, Infinity],
})

const histogramFlushTimeSeconds = new Histogram({
    name: 'recording_blob_ingestion_session_flush_time_seconds',
    help: 'The time taken to flush a session in seconds',
    buckets: [0, 1, 2, 5, 10, 20, 30, 60, 120, Infinity],
})

const histogramSessionSize = new Histogram({
    name: 'recording_blob_ingestion_session_lines',
    help: 'The size of sessions in numbers of lines',
    buckets: [0, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 2000, 5000, Infinity],
})

// The buffer is a list of messages grouped
type SessionBuffer = {
    id: string
    oldestKafkaTimestamp: number | null
    newestKafkaTimestamp: number | null
    sizeEstimate: number
    count: number
    file: string
    fileStream: WriteStream
    offsets: {
        lowest: number
        highest: number
    }
    eventsRange: {
        firstTimestamp: number
        lastTimestamp: number
    } | null
    createdAt: number
}

const MAX_FLUSH_TIME_MS = 60 * 1000

export class SessionManager {
    buffer: SessionBuffer
    flushBuffer?: SessionBuffer
    destroying = false
    realtime = false
    inProgressUpload: Upload | null = null
    unsubscribe: () => void
    flushJitterMultiplier: number

    constructor(
        public readonly serverConfig: PluginsServerConfig,
        public readonly s3Client: ObjectStorage['s3'],
        public readonly realtimeManager: RealtimeManager,
        public readonly teamId: number,
        public readonly sessionId: string,
        public readonly partition: number,
        public readonly topic: string,
        private readonly onFinish: (offsetsToRemove: number[]) => void
    ) {
        this.buffer = this.createBuffer()

        // NOTE: a new SessionManager indicates that either everything has been flushed or a rebalance occured so we should clear the existing redis messages
        void realtimeManager.clearAllMessages(this.teamId, this.sessionId)

        this.unsubscribe = realtimeManager.onSubscriptionEvent(this.teamId, this.sessionId, () => {
            void this.startRealtime()
        })

        // We add a jitter multiplier to the buffer age so that we don't have all sessions flush at the same time
        this.flushJitterMultiplier = 1 - Math.random() * serverConfig.SESSION_RECORDING_BUFFER_AGE_JITTER
    }

    private logContext = () => {
        return {
            sessionId: this.sessionId,
            partition: this.partition,
            teamId: this.teamId,
            topic: this.topic,
            oldestKafkaTimestamp: this.buffer.oldestKafkaTimestamp,
            oldestKafkaTimestampHumanReadable: this.buffer.oldestKafkaTimestamp
                ? DateTime.fromMillis(this.buffer.oldestKafkaTimestamp).toISO()
                : undefined,
            bufferCount: this.buffer.count,
        }
    }

    private captureException(error: Error, extra: Record<string, any> = {}): void {
        const context = this.logContext()
        captureException(error, {
            extra: { ...context, ...extra },
            tags: { teamId: context.teamId, sessionId: context.sessionId, partition: context.partition },
        })
    }

    private captureMessage(message: string, extra: Record<string, any> = {}): void {
        const context = this.logContext()
        captureMessage(message, {
            extra: { ...context, ...extra },
            tags: { teamId: context.teamId, sessionId: context.sessionId, partition: context.partition },
        })
    }

    public add(message: IncomingRecordingMessage): void {
        if (this.destroying) {
            return
        }

        this.addToBuffer(message)

        // NOTE: This is uncompressed size estimate but thats okay as we currently want to over-flush to see if we can shake out a bug
        if (this.buffer.sizeEstimate >= this.serverConfig.SESSION_RECORDING_MAX_BUFFER_SIZE_KB * 1024) {
            void this.flush('buffer_size')
        }
    }

    public get isEmpty(): boolean {
        return !this.buffer.count && !this.flushBuffer?.count
    }

    public async flushIfSessionBufferIsOld(referenceNow: number): Promise<void> {
        if (this.destroying) {
            return
        }

        const flushThresholdMs = this.serverConfig.SESSION_RECORDING_MAX_BUFFER_AGE_SECONDS * 1000
        const flushThresholdJitteredMs = flushThresholdMs * this.flushJitterMultiplier
        const flushThresholdMemoryMs =
            flushThresholdJitteredMs * this.serverConfig.SESSION_RECORDING_BUFFER_AGE_IN_MEMORY_MULTIPLIER

        const logContext: Record<string, any> = {
            ...this.logContext(),
            referenceTime: referenceNow,
            referenceTimeHumanReadable: DateTime.fromMillis(referenceNow).toISO(),
            flushThresholdMs,
            flushThresholdJitteredMs,
            flushThresholdMemoryMs,
        }

        if (this.buffer.oldestKafkaTimestamp === null) {
            // We have no messages yet, so we can't flush
            if (this.buffer.count > 0) {
                throw new Error('Session buffer has messages but oldest timestamp is null. A paradox!')
            }
            status.warn('🚽', `blob_ingester_session_manager buffer has no oldestKafkaTimestamp yet`, { logContext })
            return
        }

        const bufferAgeInMemoryMs = now() - this.buffer.createdAt
        const bufferAgeFromReferenceMs = referenceNow - this.buffer.oldestKafkaTimestamp

        // check the in-memory age against a larger value than the flush threshold,
        // otherwise we'll flap between reasons for flushing when close to real-time processing
        const isSessionAgeOverThreshold = bufferAgeInMemoryMs >= flushThresholdMemoryMs
        const isBufferAgeOverThreshold = bufferAgeFromReferenceMs >= flushThresholdJitteredMs

        logContext['bufferAgeInMemoryMs'] = bufferAgeInMemoryMs
        logContext['bufferAgeFromReferenceMs'] = bufferAgeFromReferenceMs
        logContext['isBufferAgeOverThreshold'] = isBufferAgeOverThreshold
        logContext['isSessionAgeOverThreshold'] = isSessionAgeOverThreshold

        histogramSessionAgeSeconds.observe(bufferAgeInMemoryMs / 1000)
        histogramSessionSize.observe(this.buffer.count)
        histogramSessionSizeKb.observe(this.buffer.sizeEstimate / 1024)

        if (isBufferAgeOverThreshold || isSessionAgeOverThreshold) {
            status.info('🚽', `blob_ingester_session_manager attempting to flushing buffer due to age`, {
                ...logContext,
            })

            // return the promise and let the caller decide whether to await
            return this.flush(isBufferAgeOverThreshold ? 'buffer_age' : 'buffer_age_realtime')
        } else {
            status.info('🚽', `blob_ingester_session_manager not flushing buffer due to age`, {
                ...logContext,
            })
        }
    }

    /**
     * Flushing takes the current buffered file and moves it to the flush buffer
     * We then attempt to write the events to S3 and if successful, we clear the flush buffer
     */
    public async flush(reason: 'buffer_size' | 'buffer_age' | 'buffer_age_realtime'): Promise<void> {
        // NOTE: The below checks don't need to throw really but we do so to help debug what might be blocking things
        if (this.flushBuffer) {
            status.warn('🚽', 'blob_ingester_session_manager flush called but we already have a flush buffer', {
                ...this.logContext(),
            })
            return
        }

        if (this.destroying) {
            status.warn('🚽', 'blob_ingester_session_manager flush called but we are in a destroying state', {
                ...this.logContext(),
            })
            return
        }

        const flushTimeout = setTimeout(() => {
            status.error('🧨', 'blob_ingester_session_manager flush timed out', {
                ...this.logContext(),
            })

            this.captureMessage('blob_ingester_session_manager flush timed out')
            this.endFlush()
        }, MAX_FLUSH_TIME_MS)

        const endFlushTimer = histogramFlushTimeSeconds.startTimer()

        try {
            // We move the buffer to the flush buffer and create a new buffer so that we can safely write the buffer to disk
            this.flushBuffer = this.buffer
            this.buffer = this.createBuffer()
            const { fileStream, file, count, eventsRange, sizeEstimate } = this.flushBuffer

            if (count === 0) {
                throw new Error("Can't flush empty buffer")
            }

            if (!eventsRange) {
                throw new Error("Can't flush buffer due to missing eventRange")
            }

            const { firstTimestamp, lastTimestamp } = eventsRange
            const baseKey = `${this.serverConfig.SESSION_RECORDING_REMOTE_FOLDER}/team_id/${this.teamId}/session_id/${this.sessionId}`
            const timeRange = `${firstTimestamp}-${lastTimestamp}`
            const dataKey = `${baseKey}/data/${timeRange}`

            // We want to ensure the writeStream has ended before we read from it
            await asyncTimeoutGuard({ message: 'session-manager.flush ending write stream delayed.' }, async () => {
                await new Promise((r) => fileStream.end(r))
            })

            const readStream = createReadStream(file, 'utf-8')
            const gzippedStream = readStream.pipe(zlib.createGzip())

            readStream.on('error', (err) => {
                // TODO: What should we do here?
                status.error('🧨', 'blob_ingester_session_manager readstream errored', {
                    ...this.logContext(),
                    error: err,
                })

                this.captureException(err)
            })

            const inProgressUpload = (this.inProgressUpload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: this.serverConfig.OBJECT_STORAGE_BUCKET,
                    Key: dataKey,
                    Body: gzippedStream,
                },
            }))

            await asyncTimeoutGuard({ message: 'session-manager.flush uploading file to S3 delayed.' }, async () => {
                await inProgressUpload.done()
            })

            readStream.close()

            counterS3FilesWritten.labels(reason).inc(1)
            histogramS3LinesWritten.observe(count)
            histogramS3KbWritten.observe(sizeEstimate / 1024)
        } catch (error: any) {
            // TRICKY: error can for some reason sometimes be undefined...
            error = error || new Error('Unknown Error')

            if (error.name === 'AbortError' && this.destroying) {
                // abort of inProgressUpload while destroying is expected
                return
            }
            // TODO: If we fail to write to S3 we should be do something about it
            status.error('🧨', 'blob_ingester_session_manager failed writing session recording blob to S3', {
                errorMessage: `${error.name || 'Unknown Error Type'}: ${error.message}`,
                error,
                ...this.logContext(),
                reason,
            })
            this.captureException(error)
            counterS3WriteErrored.inc()
        } finally {
            clearTimeout(flushTimeout)
            endFlushTimer()
            this.endFlush()
        }
    }

    private endFlush(): void {
        if (!this.flushBuffer) {
            return
        }
        const { offsets } = this.flushBuffer
        const timeout = timeoutGuard(`session-manager.endFlush delayed. Waiting over 30 seconds.`)
        try {
            this.inProgressUpload = null
            // We turn off real time as the file will now be in S3
            this.realtime = false
            // We want to delete the flush buffer before we proceed so that the onFinish handler doesn't reference it
            void this.destroyBuffer(this.flushBuffer)
            this.flushBuffer = undefined
            this.onFinish([offsets.lowest, offsets.highest])
        } catch (error) {
            this.captureException(error)
        } finally {
            clearTimeout(timeout)
        }
    }

    private createBuffer(): SessionBuffer {
        try {
            const id = randomUUID()
            const file = path.join(
                bufferFileDir(this.serverConfig.SESSION_RECORDING_LOCAL_DIRECTORY),
                `${this.teamId}.${this.sessionId}.${id}.jsonl`
            )
            const buffer: SessionBuffer = {
                id,
                createdAt: now(),
                count: 0,
                sizeEstimate: 0,
                oldestKafkaTimestamp: null,
                newestKafkaTimestamp: null,
                file,
                fileStream: createWriteStream(file, 'utf-8'),
                offsets: {
                    lowest: Infinity,
                    highest: -Infinity,
                },
                eventsRange: null,
            }

            buffer.fileStream.on('error', (err) => {
                // TODO: What should we do here?
                status.error('🧨', 'blob_ingester_session_manager writestream errored', {
                    ...this.logContext(),
                    error: err,
                })

                this.captureException(err)
            })

            return buffer
        } catch (error) {
            this.captureException(error)
            throw error
        }
    }

    /**
     * Full messages (all chunks) are added to the buffer directly
     */
    private addToBuffer(message: IncomingRecordingMessage): void {
        try {
            this.buffer.oldestKafkaTimestamp = Math.min(
                this.buffer.oldestKafkaTimestamp ?? message.metadata.timestamp,
                message.metadata.timestamp
            )

            this.buffer.newestKafkaTimestamp = Math.max(
                this.buffer.newestKafkaTimestamp ?? message.metadata.timestamp,
                message.metadata.timestamp
            )

            const messageData = convertToPersistedMessage(message)
            this.setEventsRangeFrom(message)

            const content = JSON.stringify(messageData) + '\n'
            this.buffer.count += 1
            this.buffer.sizeEstimate += content.length
            this.buffer.offsets.lowest = Math.min(this.buffer.offsets.lowest, message.metadata.offset)
            this.buffer.offsets.highest = Math.max(this.buffer.offsets.highest, message.metadata.offset)

            if (this.realtime) {
                // We don't care about the response here as it is an optimistic call
                void this.realtimeManager.addMessage(message)
            }

            this.buffer.fileStream.write(content)
        } catch (error) {
            this.captureException(error, { message })
            throw error
        }
    }
    private setEventsRangeFrom(message: IncomingRecordingMessage) {
        const start = message.events.at(0)?.timestamp
        const end = message.events.at(-1)?.timestamp

        if (!start || !end) {
            captureMessage(
                "blob_ingester_session_manager: can't set events range from message without events summary",
                {
                    extra: { message },
                    tags: {
                        team_id: this.teamId,
                        session_id: this.sessionId,
                    },
                }
            )
            return
        }

        const firstTimestamp = Math.min(start, this.buffer.eventsRange?.firstTimestamp || Infinity)
        const lastTimestamp = Math.max(end || start, this.buffer.eventsRange?.lastTimestamp || -Infinity)

        this.buffer.eventsRange = { firstTimestamp, lastTimestamp }
    }

    private async startRealtime() {
        if (this.realtime) {
            return
        }

        status.info('⚡️', `blob_ingester_session_manager Real-time mode started `, { sessionId: this.sessionId })

        this.realtime = true

        try {
            const timestamp = this.buffer.oldestKafkaTimestamp ?? 0
            const existingContent = await readFile(this.buffer.file, 'utf-8')
            await this.realtimeManager.addMessagesFromBuffer(this.teamId, this.sessionId, existingContent, timestamp)
            status.info('⚡️', 'blob_ingester_session_manager loaded existing snapshot buffer into realtime', {
                sessionId: this.sessionId,
                teamId: this.teamId,
            })
        } catch (e) {
            status.error('🧨', 'blob_ingester_session_manager failed loading existing snapshot buffer', {
                sessionId: this.sessionId,
                teamId: this.teamId,
            })
            this.captureException(e)
        }
    }

    public async destroy(): Promise<void> {
        this.destroying = true
        this.unsubscribe()
        if (this.inProgressUpload !== null) {
            await this.inProgressUpload.abort().catch((error) => {
                status.error('🧨', 'blob_ingester_session_manager failed to abort in progress upload', {
                    ...this.logContext(),
                    error,
                })
                this.captureException(error)
            })
            this.inProgressUpload = null
        }

        if (this.flushBuffer) {
            await this.destroyBuffer(this.flushBuffer)
        }
        await this.destroyBuffer(this.buffer)
    }

    public getLowestOffset(): number | null {
        if (this.buffer.count === 0) {
            return null
        }
        return Math.min(this.buffer.offsets.lowest, this.flushBuffer?.offsets.lowest ?? Infinity)
    }

    private async destroyBuffer(buffer: SessionBuffer): Promise<void> {
        await new Promise<void>((resolve) => {
            buffer.fileStream.close(async () => {
                try {
                    await stat(buffer.file)
                    await unlink(buffer.file)
                } catch (error) {
                    // Indicates the file was already deleted (i.e. if there was never any data in the buffer)
                }

                resolve()
            })
        })
    }
}
