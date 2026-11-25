package bot.dusk.mobile;

import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.junit.Test;

public class NotificationChannelsTest {

    @Test
    public void manifestDefaultChannelIsMessages() throws Exception {
        String manifest = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        assertTrue(manifest.matches("(?s).*android:name=\"com\\.google\\.firebase\\.messaging\\.default_notification_channel_id\"\\s+android:value=\"" + NotificationChannels.MESSAGES + "\".*"));
    }

    @Test
    public void manifestDefaultNotificationIconIsMonochromeVector() throws Exception {
        String manifest = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        assertTrue(manifest.matches("(?s).*android:name=\"com\\.google\\.firebase\\.messaging\\.default_notification_icon\"\\s+android:resource=\"@drawable/ic_stat_duskbot\".*"));
        String drawable = new String(Files.readAllBytes(Paths.get("src/main/res/drawable/ic_stat_duskbot.xml")), StandardCharsets.UTF_8);
        assertTrue(drawable.contains("<vector"));
        assertTrue(drawable.contains("android:fillColor=\"#FFFFFFFF\""));
    }
}
