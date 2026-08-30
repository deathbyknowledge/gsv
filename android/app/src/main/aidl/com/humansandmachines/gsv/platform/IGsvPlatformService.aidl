package com.humansandmachines.gsv.platform;

import android.content.ComponentName;
import android.graphics.Point;
import android.os.ParcelFileDescriptor;

/**
 * Narrow, versioned boundary to capabilities owned by GSV OS.
 *
 * Methods added after version 1 must be gated by getApiVersion() on both sides.
 */
interface IGsvPlatformService {
    int getApiVersion();
    String getServiceVersion();
    long getStartedElapsedRealtimeMillis();

    /** API version 2: OS-owned display, input, and activity primitives. */
    Point getDisplaySize();
    ParcelFileDescriptor captureScreenshotPng(int maxDimension);
    @nullable ComponentName getForegroundActivity();
    boolean launchApp(String packageName);
    void tap(int x, int y);
    void swipe(int startX, int startY, int endX, int endY, int durationMillis);
    void pressKey(String keyName);
    void typeText(String text);
}
