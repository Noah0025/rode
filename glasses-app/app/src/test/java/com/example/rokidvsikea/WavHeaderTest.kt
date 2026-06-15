package com.example.rokidvsikea

import org.junit.Assert.assertEquals
import org.junit.Test

class WavHeaderTest {
    @Test
    fun header_has_RIFF_and_correct_sizes() {
        val pcmBytes = 1600 // 0.05s @16kHz mono 16-bit = 1600 bytes
        val header = wavHeader(pcmBytes, sampleRate = 16000, channels = 1, bitsPerSample = 16)
        assertEquals(44, header.size)
        assertEquals('R'.code.toByte(), header[0])
        assertEquals('I'.code.toByte(), header[1])
        assertEquals('F'.code.toByte(), header[2])
        assertEquals('F'.code.toByte(), header[3])
        // ChunkSize = 36 + dataLen at offset 4 (little-endian)
        val chunkSize = (header[4].toInt() and 0xff) or
            ((header[5].toInt() and 0xff) shl 8) or
            ((header[6].toInt() and 0xff) shl 16) or
            ((header[7].toInt() and 0xff) shl 24)
        assertEquals(36 + pcmBytes, chunkSize)
    }
}
