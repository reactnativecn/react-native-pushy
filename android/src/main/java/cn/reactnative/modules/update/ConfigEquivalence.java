package cn.reactnative.modules.update;

import androidx.annotation.Nullable;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Cross-platform canonical equality of native-check config JSON strings
 * (shared contract with the JS / iOS / Harmony sides). Two configs are
 * equivalent iff their canonical forms deep-equal:
 * <ul>
 * <li>absent keys take the defaults {disabled: false, queryUrls: [], rnu: "",
 * rn: "", afterDownload: "none"};</li>
 * <li>each string in endpoints / queryUrls loses its trailing '/', then
 * duplicates are dropped keeping the first occurrence;</li>
 * <li>key order is irrelevant.</li>
 * </ul>
 * Anything that is not a JSON object string is never equivalent to anything.
 */
final class ConfigEquivalence {
    private static final Object NULL_VALUE = new Object();

    private ConfigEquivalence() {
    }

    static boolean equivalent(@Nullable String a, @Nullable String b) {
        Map<String, Object> left = canonical(a);
        if (left == null) {
            return false;
        }
        Map<String, Object> right = canonical(b);
        return right != null && left.equals(right);
    }

    @Nullable
    static Map<String, Object> canonical(@Nullable String json) {
        if (json == null) {
            return null;
        }
        Object parsed;
        try {
            parsed = new JSONTokener(json).nextValue();
        } catch (JSONException e) {
            return null;
        }
        if (!(parsed instanceof JSONObject)) {
            return null;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) toCanonical(parsed);
        putDefault(result, "disabled", Boolean.FALSE);
        putDefault(result, "queryUrls", new ArrayList<Object>());
        putDefault(result, "rnu", "");
        putDefault(result, "rn", "");
        putDefault(result, "afterDownload", "none");
        normalizeUrls(result, "endpoints");
        normalizeUrls(result, "queryUrls");
        return result;
    }

    private static void putDefault(Map<String, Object> map, String key, Object value) {
        if (!map.containsKey(key)) {
            map.put(key, value);
        }
    }

    private static void normalizeUrls(Map<String, Object> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof List)) {
            return;
        }
        LinkedHashSet<Object> unique = new LinkedHashSet<>();
        for (Object item : (List<?>) value) {
            unique.add(item instanceof String ? stripTrailingSlashes((String) item) : item);
        }
        map.put(key, new ArrayList<Object>(unique));
    }

    private static String stripTrailingSlashes(String url) {
        int end = url.length();
        while (end > 0 && url.charAt(end - 1) == '/') {
            end--;
        }
        return url.substring(0, end);
    }

    // JSONObject/JSONArray have identity equals; convert to Map/List with
    // value semantics. Numbers compare by value (1 == 1.0).
    private static Object toCanonical(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Map<String, Object> map = new HashMap<>();
            for (Iterator<String> keys = object.keys(); keys.hasNext();) {
                String key = keys.next();
                map.put(key, toCanonical(object.opt(key)));
            }
            return map;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            List<Object> list = new ArrayList<>(array.length());
            for (int i = 0; i < array.length(); i++) {
                list.add(toCanonical(array.opt(i)));
            }
            return list;
        }
        if (value instanceof Number) {
            try {
                return new BigDecimal(value.toString()).stripTrailingZeros();
            } catch (NumberFormatException e) {
                return value.toString();
            }
        }
        if (value == null || value == JSONObject.NULL) {
            return NULL_VALUE;
        }
        return value;
    }
}
