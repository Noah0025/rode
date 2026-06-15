package com.example.rokidvsikea

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Wraps Android TextToSpeech for Chinese playback with availability detection.
 * [onReady] reports whether a Chinese voice is usable; if not, the caller falls back
 * (v1: surface the failure on the HUD, show text only).
 */
class TtsSpeaker(
    context: Context,
    private val onReady: (chineseAvailable: Boolean) -> Unit,
    private val onSpeechDone: () -> Unit,
) {
    companion object { private const val TAG = "TtsSpeaker" }

    private var tts: TextToSpeech? = null
    private var ready = false
    private val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 80)

    init {
        tts = TextToSpeech(context) { status ->
            if (status != TextToSpeech.SUCCESS) {
                Log.e(TAG, "TTS init failed: $status")
                onReady(false); return@TextToSpeech
            }
            val res = tts?.setLanguage(Locale.CHINESE)
            val ok = res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED
            ready = ok
            if (ok) {
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) { onSpeechDone() }
                    @Deprecated("deprecated in API level 21") override fun onError(utteranceId: String?) { onSpeechDone() }
                })
            } else {
                Log.e(TAG, "Chinese voice unavailable (res=$res)")
            }
            onReady(ok)
        }
    }

    /** Plays a short earcon so the user knows recording/processing boundaries. */
    fun earcon() {
        try { tone.startTone(ToneGenerator.TONE_PROP_BEEP, 120) } catch (_: Throwable) {}
    }

    fun speak(text: String) {
        if (!ready || text.isBlank()) { onSpeechDone(); return }
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "rode-${text.hashCode()}")
    }

    fun stop() { tts?.stop() }

    fun shutdown() {
        try { tts?.stop(); tts?.shutdown() } catch (_: Throwable) {}
        try { tone.release() } catch (_: Throwable) {}
        tts = null
    }
}
