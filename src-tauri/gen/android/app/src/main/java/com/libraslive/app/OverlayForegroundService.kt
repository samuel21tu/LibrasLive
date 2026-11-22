package com.libraslive.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service real do LibrasLive no Android.
 * Mantem a notificacao persistente e traz a Activity transparente do Tauri
 * para a frente quando o usuario troca de aplicativo.
 */
class OverlayForegroundService : Service() {
    companion object {
        const val ACTION_START = "com.libraslive.app.overlay.START"
        const val ACTION_STOP = "com.libraslive.app.overlay.STOP"
        private const val CHANNEL_ID = "libraslive-overlay"
        private const val NOTIFICATION_ID = 1001
        private const val TAG = "LibrasLiveOverlay"
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification())
        showOverlayActivity()
        return START_STICKY
    }

    private fun showOverlayActivity() {
        val overlay = Intent(this, MainActivity::class.java)
        overlay.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        try {
            startActivity(overlay)
        } catch (exception: Exception) {
            Log.e(TAG, "Nao foi possivel abrir a Activity do overlay.", exception)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Overlay LibrasLive",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.description = "Mantem o avatar de LIBRAS visivel sobre outros aplicativos."
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, OverlayForegroundService::class.java)
        stopIntent.action = ACTION_STOP
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        val stopPending = PendingIntent.getService(this, 2, stopIntent, flags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("LibrasLive ativo")
            .setContentText("Avatar de LIBRAS visivel sobre outros aplicativos.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(android.R.drawable.ic_delete, "Encerrar", stopPending)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
