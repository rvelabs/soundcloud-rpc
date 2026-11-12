package io.rvelabs.soundcloud.android

import android.content.ComponentName
import android.os.Looper
import android.os.SystemClock
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BackgroundPlaybackTest {
    @Test
    fun queueAdvancesTwiceWhileScreenIsOff() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        ActivityScenario.launch(MainActivity::class.java).use {
            val start = device.wait(Until.findObject(By.text("Запустить тестовую очередь")), 15_000)
            assertNotNull("The local Android interface did not render", start)
            val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
            val future = MediaController.Builder(context, token).setApplicationLooper(Looper.getMainLooper()).buildAsync()
            val player = future.get(10, TimeUnit.SECONDS)
            try {
                start!!.click()
                var index = -1
                var playing = false
                var error: String? = null
                fun readState() {
                    instrumentation.runOnMainSync {
                        index = player.currentMediaItemIndex
                        playing = player.isPlaying
                        error = player.playerError?.message
                    }
                }
                val readyBy = SystemClock.elapsedRealtime() + 4_000
                do {
                    readState()
                    if (index == 0 && playing) break
                    SystemClock.sleep(50)
                } while (SystemClock.elapsedRealtime() < readyBy)
                assertEquals("First track must start before turning off the screen", 0, index)
                assertTrue(error ?: "First fixture did not play", playing)
                device.sleep()
                assertFalse("The emulator screen must be off", device.isScreenOn)
                val transitionBy = SystemClock.elapsedRealtime() + 13_000
                do {
                    readState()
                    if (index >= 2 || error != null) break
                    SystemClock.sleep(100)
                } while (SystemClock.elapsedRealtime() < transitionBy)
                assertFalse("The emulator screen turned on during playback", device.isScreenOn)
                assertEquals(error ?: "Queue did not advance to the third track", 2, index)
            } finally {
                device.wakeUp()
                instrumentation.runOnMainSync {
                    player.stop()
                    player.clearMediaItems()
                    player.release()
                }
            }
        }
    }
}
