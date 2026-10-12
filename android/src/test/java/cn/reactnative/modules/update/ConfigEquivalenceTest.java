package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ConfigEquivalenceTest {
    private static final String VECTORS =
        "cpp/update_flow_core/tests/config-equivalence-vectors.json";

    // The shared C1 vectors live at the package root (next to android/). Gradle
    // runs unit tests from the module directory, which is android/ in this repo
    // and node_modules/react-native-update/android in a host app; walk up from
    // there so both layouts (and symlinked copies) resolve.
    private static File vectorsFile() {
        String override = System.getProperty("pushy.configVectors");
        if (override != null) {
            return new File(override);
        }
        for (File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
                dir != null; dir = dir.getParentFile()) {
            File candidate = new File(dir, VECTORS);
            if (candidate.isFile()) {
                return candidate;
            }
        }
        return null;
    }

    @Test
    public void sharedVectors() throws Exception {
        File file = vectorsFile();
        assertNotNull("cannot locate " + VECTORS + " above " + System.getProperty("user.dir"), file);
        JSONArray cases = new JSONObject(
            new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8))
            .getJSONArray("cases");
        assertTrue("vector file has cases", cases.length() >= 30);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject vector = cases.getJSONObject(i);
            String name = vector.getString("name");
            String a = vector.getString("a");
            String b = vector.getString("b");
            boolean equivalent = vector.getBoolean("equivalent");
            assertEquals(name, equivalent, ConfigEquivalence.equivalent(a, b));
            assertEquals(name + " (reversed)", equivalent, ConfigEquivalence.equivalent(b, a));
        }
    }

    @Test
    public void missingConfigIsNeverEquivalent() {
        assertFalse(ConfigEquivalence.equivalent(null, null));
        assertFalse(ConfigEquivalence.equivalent("{\"appKey\":\"k\"}", null));
        assertFalse(ConfigEquivalence.equivalent(null, "{\"appKey\":\"k\"}"));
    }
}
