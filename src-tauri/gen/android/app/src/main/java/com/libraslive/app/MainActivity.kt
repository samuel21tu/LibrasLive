package com.libraslive.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import app.tauri.TauriActivity

/**
 * Atividade Tauri. Solicita SYSTEM_ALERT_WINDOW e inicia o foreground service
 * que mantem o overlay de LIBRAS acima dos outros aplicativos.
 */
class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
            return
        }

        requestNotificationPermission()
        startOverlayService()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1002)
        }
    }

    private fun startOverlayService() {
        val intent = Intent(this, OverlayForegroundService::class.java)
        intent.action = OverlayForegroundService.ACTION_START
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }
}
