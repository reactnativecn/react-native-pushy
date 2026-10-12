package cn.reactnative.modules.update;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class ConfigEquivalenceTest {
    @Test
    public void ignoresKeyOrder() {
        assertTrue(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\",\"endpoints\":[\"https://a\"]}",
            "{\"endpoints\":[\"https://a\"],\"appKey\":\"k\"}"));
    }

    @Test
    public void fillsDefaultsForAbsentKeys() {
        assertTrue(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\"}",
            "{\"appKey\":\"k\",\"disabled\":false,\"queryUrls\":[],\"rnu\":\"\","
                + "\"rn\":\"\",\"afterDownload\":\"none\"}"));
        assertFalse(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\"}", "{\"appKey\":\"k\",\"disabled\":true}"));
        assertFalse(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\"}", "{\"appKey\":\"k\",\"rn\":\"0.80.0\"}"));
    }

    @Test
    public void normalizesUrlListsKeepingFirstOccurrence() {
        assertTrue(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\",\"endpoints\":[\"https://a/\",\"https://b\",\"https://a\"],"
                + "\"queryUrls\":[\"https://q//\",\"https://q\"]}",
            "{\"appKey\":\"k\",\"endpoints\":[\"https://a\",\"https://b\"],"
                + "\"queryUrls\":[\"https://q\"]}"));
        // Order is meaningful: it is the fallback order.
        assertFalse(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\",\"endpoints\":[\"https://a\",\"https://b\"]}",
            "{\"appKey\":\"k\",\"endpoints\":[\"https://b\",\"https://a\"]}"));
    }

    @Test
    public void detectsRealChanges() {
        assertFalse(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\"}", "{\"appKey\":\"other\"}"));
        assertFalse(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\"}", "{\"appKey\":\"k\",\"packageVersion\":\"1.0\"}"));
        assertTrue(ConfigEquivalence.equivalent(
            "{\"appKey\":\"k\",\"n\":1}", "{\"appKey\":\"k\",\"n\":1.0}"));
    }

    @Test
    public void unparseableIsNeverEquivalent() {
        assertFalse(ConfigEquivalence.equivalent(null, null));
        assertFalse(ConfigEquivalence.equivalent("{", "{"));
        assertFalse(ConfigEquivalence.equivalent("[]", "[]"));
        assertFalse(ConfigEquivalence.equivalent("{\"appKey\":\"k\"}", null));
    }
}
