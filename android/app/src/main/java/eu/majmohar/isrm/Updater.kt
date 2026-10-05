package eu.majmohar.isrm

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.widget.Toast
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates for the self-hosted APK: downloads it into the app's private cache and hands it to the system
 * PackageInstaller. Android still asks once for "install unknown apps" and usually for a confirm tap; from Android 12,
 * once this app has installed itself, later updates can go through without that tap. A different signing key is
 * rejected by the system, so only builds signed with the IŠRM key can replace the app.
 */
object Updater {
    private const val ACTION_STATUS = "eu.majmohar.isrm.UPDATE_STATUS"
    const val EXTRA_UPDATED = "eu.majmohar.isrm.UPDATED"

    /** Downloads [url] (HTTPS only) and reports progress 0–100, or -1 while the size is unknown. */
    fun download(context: Context, url: String, onProgress: (Int) -> Unit): File {
        require(url.startsWith("https://")) { "Posodobitev mora biti na HTTPS." }
        val target = File(context.cacheDir, "update.apk").apply { delete() }
        val connection = (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 10_000; readTimeout = 30_000 }
        if (connection.responseCode !in 200..299) throw ApiException("Prenos ni uspel (HTTP ${connection.responseCode}).")
        val total = connection.contentLengthLong
        var done = 0L; var lastReported = -2
        connection.inputStream.use { input ->
            target.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read); done += read
                    val percent = if (total > 0) (done * 100 / total).toInt() else -1
                    if (percent != lastReported) { lastReported = percent; onProgress(percent) }
                }
            }
        }
        if (target.length() < 100_000) throw ApiException("Preneseni paket je nepopoln.")
        return target
    }

    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input -> session.openWrite("isrm.apk", 0, apk.length()).use { output -> input.copyTo(output); session.fsync(output) } }
            val status = Intent(context, UpdateReceiver::class.java).setAction(ACTION_STATUS)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).intentSender)
        }
    }

    fun isStatus(intent: Intent) = intent.action == ACTION_STATUS
}

class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when {
            // After the update Android restarts nothing on its own. Reopening only works up to Android 9; newer versions
            // block activity starts from the background, so the update sheet tells the user to reopen the app.
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED ->
                context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(Updater.EXTRA_UPDATED, true))
            Updater.isStatus(intent) -> when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                    confirm?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
                PackageInstaller.STATUS_SUCCESS -> Unit
                PackageInstaller.STATUS_FAILURE_ABORTED -> Toast.makeText(context, "Posodobitev je preklicana.", Toast.LENGTH_SHORT).show()
                else -> Toast.makeText(context, "Posodobitev ni uspela: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "neznana napaka"}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
