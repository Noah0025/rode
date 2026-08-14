package com.helm.rode

import android.media.AudioManager
import android.media.ToneGenerator

/**
 * 只负责录音边界提示音。
 * YodaOS 实机已确认裁掉 TextToSpeech 系统服务，端侧 TTS 不可用；回答音频统一由后端
 * 合成，再由 RodeClient 的 MediaPlayer 路径播放。
 */
class TtsSpeaker {
    private val tone: ToneGenerator? = try { ToneGenerator(AudioManager.STREAM_MUSIC, 80) } catch (_: Throwable) { null }

    /** Plays a short earcon so the user knows recording/processing boundaries. */
    fun earcon() {
        try { tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120) } catch (_: Throwable) {}
    }

    fun shutdown() {
        try { tone?.release() } catch (_: Throwable) {}
    }
}
