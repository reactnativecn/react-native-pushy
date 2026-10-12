package cn.reactnative.modules.update;

/**
 * JNI bindings to the shared update-flow decision layer
 * (cpp/update_flow_core). String-in/string-out JSON on purpose — it matches
 * the decision layer's own boundary and keeps this surface trivially stable.
 * A null return means the input did not parse; callers skip the check round.
 */
final class FlowBridge {
    private FlowBridge() {
    }

    static native String buildRequestBody(String inputJson);

    static native String orderEndpointCandidates(String endpointsJson, double randomSample);

    static native boolean isValidResponse(String responseText);

    static native String handleResponse(
        String responseText, String identityJson, String afterDownload);

    // Persisted-config layer (cpp/update_flow_core/native_config.h), shared
    // with iOS and Harmony.

    /** Contract C1: same config in another serialization. Null is never equivalent. */
    static native boolean configsEquivalent(String a, String b);

    /**
     * The run gate: {"appKey": trimmed} when the config may run a round,
     * otherwise {"status", "reason"}. Null config text = not configured.
     */
    static native String runnableConfig(String configJson);

    /**
     * Validates host configure() options (a JSON object) into the config to
     * persist. Throws IllegalArgumentException("Invalid native configuration:
     * ...") for options the host must fix.
     */
    static native String normalizeConfiguration(String optionsJson);
}
