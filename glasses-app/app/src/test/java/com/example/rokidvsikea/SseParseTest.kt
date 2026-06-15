package com.example.rokidvsikea

import org.junit.Assert.assertEquals
import org.junit.Test

class SseParseTest {
    @Test
    fun parses_data_line_into_event() {
        val ev = parseSseDataLine("""data: {"type":"answer","text":"你好"}""")
        assertEquals("answer", ev?.type)
        assertEquals("你好", ev?.text)
    }

    @Test
    fun ignores_non_data_and_blank_lines() {
        assertEquals(null, parseSseDataLine(""))
        assertEquals(null, parseSseDataLine(": keepalive"))
        assertEquals(null, parseSseDataLine("event: message"))
    }

    @Test
    fun done_event_has_null_text() {
        val ev = parseSseDataLine("""data: {"type":"done"}""")
        assertEquals("done", ev?.type)
        assertEquals(null, ev?.text)
    }
}
