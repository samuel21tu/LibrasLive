# Android — Tauri 2

Os arquivos `AndroidManifest.xml`, `MainActivity.kt` e `OverlayForegroundService.kt` são as
personalizações de plataforma do LibrasLive. O restante do projeto Gradle é gerado por:

```bash
npm run tauri android init
npm run tauri android build
adb install -r src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk
```

Se `tauri android init` recriar o projeto e sobrescrever estes arquivos, copie-os de volta
antes de gerar o APK. O `AndroidManifest.xml` declara `SYSTEM_ALERT_WINDOW`,
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS` e `RECORD_AUDIO`.

Limitação real: o Android **não oferece loopback global de áudio do sistema**. Use microfone
em modo compatibilidade ou um serviço de acessibilidade para texto. O app não finge ter
acesso ao áudio dos outros aplicativos.
