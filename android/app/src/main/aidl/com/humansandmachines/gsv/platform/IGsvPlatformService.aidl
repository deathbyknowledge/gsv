package com.humansandmachines.gsv.platform;

/**
 * Narrow, versioned boundary to capabilities owned by GSV OS.
 *
 * Methods added after version 1 must be gated by getApiVersion() on both sides.
 */
interface IGsvPlatformService {
    int getApiVersion();
    String getServiceVersion();
    long getStartedElapsedRealtimeMillis();
}
