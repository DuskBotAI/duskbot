package bot.dusk.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * The bots of the place on screen as the launcher's long-press shortcuts (Android 7.1+), each opening its chat through
 * the app's own duskbot://open link.
 */
@CapacitorPlugin(name = "DuskShortcuts")
public class ShortcutsPlugin extends Plugin {

    @PluginMethod
    public void setBots(PluginCall call) {
        String place = call.getString("place", "");
        JSArray bots = call.getArray("bots", new JSArray());
        if (Build.VERSION.SDK_INT < 25 || place.isEmpty()) { call.resolve(); return; }
        Context context = getContext();
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        if (manager == null) { call.resolve(); return; }
        int room = Math.min(4, manager.getMaxShortcutCountPerActivity());
        List<ShortcutInfo> shortcuts = new ArrayList<>();
        for (int at = 0; at < bots.length() && shortcuts.size() < room; at++) {
            JSONObject bot = bots.optJSONObject(at);
            if (bot == null) continue;
            String id = bot.optString("id", ""), name = bot.optString("name", "");
            if (id.isEmpty() || name.isEmpty()) continue;
            Uri link = new Uri.Builder().scheme("duskbot").authority("open").appendQueryParameter("env", place).appendQueryParameter("bot", id).build();
            Intent open = new Intent(Intent.ACTION_VIEW, link).setPackage(context.getPackageName());
            shortcuts.add(new ShortcutInfo.Builder(context, "bot:" + place + ":" + id)
                .setShortLabel(name)
                .setLongLabel(name)
                .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                .setIntent(open)
                .setRank(shortcuts.size())
                .build());
        }
        try { manager.setDynamicShortcuts(shortcuts); } catch (IllegalStateException | IllegalArgumentException ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void forget(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 25) {
            ShortcutManager manager = getContext().getSystemService(ShortcutManager.class);
            if (manager != null) manager.removeAllDynamicShortcuts();
        }
        call.resolve();
    }

    @PluginMethod
    public void take(PluginCall call) {
        call.resolve(new com.getcapacitor.JSObject().put("actions", new JSArray()));
    }
}
