package eu.majmohar.isrm

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

class WidgetConfigureActivity : AppCompatActivity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    override fun onCreate(state: Bundle?) { super.onCreate(state); setResult(RESULT_CANCELED); setContentView(R.layout.activity_widget_configure)
        widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId); if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        val current = WidgetPrefs.get(this, widgetId); val mode = findViewById<Spinner>(R.id.mode); val year = findViewById<Spinner>(R.id.year)
        mode.setSelection(if (current.mode == "day") 1 else 0); year.setSelection(current.programme.toInt() - 1); findViewById<EditText>(R.id.student).setText(current.student); findViewById<EditText>(R.id.server_url).setText(current.baseUrl)
        findViewById<Button>(R.id.save).setOnClickListener { WidgetPrefs.put(this, widgetId, WidgetConfig(if (mode.selectedItemPosition == 1) "day" else "next", (year.selectedItemPosition + 1).toString(), findViewById<EditText>(R.id.student).text.toString().filter(Char::isDigit), findViewById<EditText>(R.id.server_url).text.toString())); WidgetRefresh.now(this); setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)); finish() }
    }
}
