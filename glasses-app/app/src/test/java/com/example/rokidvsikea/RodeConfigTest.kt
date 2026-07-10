package com.example.rokidvsikea

import org.junit.Assert.assertEquals
import org.junit.Test

class RodeConfigTest {
    @Test fun prefs_over_fallback() {
        assertEquals("https://prefs", RodeConfig.pick("https://prefs", "https://build"))
    }

    @Test fun fallback_when_blank() {
        assertEquals("https://build", RodeConfig.pick("", "https://build"))
    }

    @Test fun fallback_when_null() {
        assertEquals("https://build", RodeConfig.pick(null, "https://build"))
    }

    @Test fun tts_defaults_on_and_pref_can_disable() {
        assertEquals(true, RodeConfig.pickBoolean(null, true))
        assertEquals(false, RodeConfig.pickBoolean(false, true))
    }
}
