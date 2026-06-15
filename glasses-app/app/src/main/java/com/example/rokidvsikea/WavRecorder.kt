package com.example.rokidvsikea

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Builds a 44-byte canonical PCM WAV header for the given data length. */
fun wavHeader(dataLen: Int, sampleRate: Int, channels: Int, bitsPerSample: Int): ByteArray {
    val byteRate = sampleRate * channels * bitsPerSample / 8
    val blockAlign = channels * bitsPerSample / 8
    val bb = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    bb.put("RIFF".toByteArray(Charsets.US_ASCII))
    bb.putInt(36 + dataLen)
    bb.put("WAVE".toByteArray(Charsets.US_ASCII))
    bb.put("fmt ".toByteArray(Charsets.US_ASCII))
    bb.putInt(16)                 // PCM fmt chunk size
    bb.putShort(1)                // audio format = PCM
    bb.putShort(channels.toShort())
    bb.putInt(sampleRate)
    bb.putInt(byteRate)
    bb.putShort(blockAlign.toShort())
    bb.putShort(bitsPerSample.toShort())
    bb.put("data".toByteArray(Charsets.US_ASCII))
    bb.putInt(dataLen)
    return bb.array()
}

/**
 * Captures 16 kHz mono PCM16 from the mic while [start]..[stop] is active,
 * returning a complete WAV byte array on [stop].
 */
class WavRecorder {
    companion object {
        private const val TAG = "WavRecorder"
        const val SAMPLE_RATE = 16000
        /** ~0.4s @16kHz mono 16-bit = 12800 PCM bytes; below this we treat as "没说话" (patch I1). */
        const val MIN_PCM_BYTES = 12800
    }

    @Volatile private var recording = false
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()

    /** 实时音量 0..1（峰值，带衰减平滑），供波形可视化用。 */
    @Volatile var amplitude: Float = 0f
        private set

    @SuppressLint("MissingPermission") // caller ensures RECORD_AUDIO granted
    fun start() {
        if (recording) return
        pcm.reset()
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(SAMPLE_RATE) // at least ~0.5s buffer
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuf
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord init failed")
            record.release()
            return
        }
        recording = true
        record.startRecording()
        thread = Thread {
            val buf = ByteArray(minBuf)
            while (recording) {
                val n = record.read(buf, 0, buf.size)
                if (n > 0) {
                    pcm.write(buf, 0, n)
                    // 峰值音量（16-bit LE）→ 0..1，带衰减平滑
                    var peak = 0
                    var i = 0
                    while (i + 1 < n) {
                        val s = (buf[i].toInt() and 0xff) or (buf[i + 1].toInt() shl 8)
                        val a = if (s < 0) -s else s
                        if (a > peak) peak = a
                        i += 2
                    }
                    val target = (peak / 32768f).coerceIn(0f, 1f)
                    amplitude = if (target > amplitude) target else amplitude * 0.6f + target * 0.4f
                }
            }
            amplitude = 0f
            record.stop()
            record.release()
        }.also { it.start() }
    }

    /**
     * Stops capture and returns a complete WAV (header + PCM). Returns empty array if nothing
     * captured OR the clip is shorter than [MIN_PCM_BYTES] (patch I1 — avoids empty turns).
     */
    fun stop(): ByteArray {
        if (!recording) return ByteArray(0)
        recording = false
        thread?.join(2000)
        thread = null
        val data = pcm.toByteArray()
        if (data.size < MIN_PCM_BYTES) return ByteArray(0)
        val header = wavHeader(data.size, SAMPLE_RATE, 1, 16)
        return header + data
    }
}
