package eu.majmohar.isrm
import android.content.Context
import org.json.*
import java.net.*
import java.time.*
data class Lesson(val title:String,val type:String,val date:String,val start:String,val end:String,val room:String,val teacher:String,val source:String)
class TimetableRepository(private val context:Context) {
 private val store=context.getSharedPreferences("timetable-cache",Context.MODE_PRIVATE)
 private fun key(w:LocalDate,y:String,s:String)="week-$w-$y-${s.ifBlank{"shared"}}"
 private fun monthKey(m:LocalDate,y:String,s:String)="month-${m.withDayOfMonth(1)}-$y-${s.ifBlank{"shared"}}"
 fun cached(w:LocalDate,y:String,s:String)=parse(store.getString(key(w,y,s),null))
 fun monthCached(m:LocalDate,y:String,s:String)=parse(store.getString(monthKey(m,y,s),null))
 fun refresh(w:LocalDate,y:String,s:String):List<Lesson>{
  val address=buildString{append("${BuildConfig.WEB_APP_URL.trimEnd('/')}/api/timetable?week=$w&programme=$y");if(s.isNotBlank())append("&student=$s")}
  val c=(URL(address).openConnection() as HttpURLConnection).apply{connectTimeout=8000;readTimeout=8000}
  val text=c.inputStream.bufferedReader().use{it.readText()};if(c.responseCode !in 200..299) error("Urnik ni dosegljiv")
  store.edit().putString(key(w,y,s),text).apply();return parse(text)
 }
 fun preload(y:String,s:String){val m=LocalDate.now().with(DayOfWeek.MONDAY);(0..5).forEach{runCatching{refresh(m.plusWeeks(it.toLong()),y,s)}}}
 fun refreshMonth(m:LocalDate,y:String,s:String):List<Lesson>{
  val address=buildString{append("${BuildConfig.WEB_APP_URL.trimEnd('/')}/api/month?month=${m.year}-${m.monthValue.toString().padStart(2,'0')}&programme=$y");if(s.isNotBlank())append("&student=$s")}
  val c=(URL(address).openConnection() as HttpURLConnection).apply{connectTimeout=8000;readTimeout=8000}
  val text=c.inputStream.bufferedReader().use{it.readText()};if(c.responseCode !in 200..299)error("Mesečni urnik ni dosegljiv")
  store.edit().putString(monthKey(m,y,s),text).apply();return parse(text)
 }
 private fun parse(text:String?)=runCatching{val a=JSONObject(text?:"{}").optJSONArray("events")?:JSONArray();(0 until a.length()).map{a.getJSONObject(it).let{r->Lesson(r.optString("title"),r.optString("type"),r.optString("date"),r.optString("start"),r.optString("end"),r.optString("room"),r.optString("teacher"),r.optString("source"))}}.sortedWith(compareBy({it.date},{it.start}))}.getOrDefault(emptyList())
}
