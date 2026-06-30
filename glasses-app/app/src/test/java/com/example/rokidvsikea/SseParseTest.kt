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
    fun parses_answer_delta_event() {
        val ev = parseSseDataLine("""data: {"type":"answer_delta","text":"晴，"}""")
        assertEquals("answer_delta", ev?.type)
        assertEquals("晴，", ev?.text)
    }

    @Test
    fun done_event_has_null_text() {
        val ev = parseSseDataLine("""data: {"type":"done"}""")
        assertEquals("done", ev?.type)
        assertEquals(null, ev?.text)
    }
}
