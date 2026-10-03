package eu.majmohar.isrm

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import androidx.appcompat.app.AppCompatActivity

class WidgetConfigureActivity : AppCompatActivity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var selectedMode = "next"

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setResult(RESULT_CANCELED)
        setContentView(R.layout.activity_widget_configure)
        widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }

        val current = WidgetPrefs.get(this, widgetId)
        val year = findViewById<Spinner>(R.id.year)
        val next = findViewById<LinearLayout>(R.id.next_option)
        val day = findViewById<LinearLayout>(R.id.day_option)
        selectedMode = if (current.mode == "day") "day" else "next"
        year.setSelection(current.programme.toIntOrNull()?.minus(1)?.coerceIn(0, 2) ?: 0)
        findViewById<EditText>(R.id.student).setText(current.student)
        next.setOnClickListener { selectedMode = "next"; updateSelection(next, day) }
        day.setOnClickListener { selectedMode = "day"; updateSelection(next, day) }
        updateSelection(next, day)

        findViewById<View>(R.id.save).setOnClickListener {
            WidgetPrefs.put(this, widgetId, WidgetConfig(selectedMode, (year.selectedItemPosition + 1).toString(), findViewById<EditText>(R.id.student).text.toString().filter(Char::isDigit), BuildConfig.WEB_APP_URL))
            WidgetRefresh.now(this)
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
            finish()
        }
    }

    private fun updateSelection(next: View, day: View) {
        val nextSelected = selectedMode == "next"
        next.setBackgroundResource(if (nextSelected) R.drawable.widget_option_selected else R.drawable.widget_option)
        day.setBackgroundResource(if (nextSelected) R.drawable.widget_option else R.drawable.widget_option_selected)
    }
}
