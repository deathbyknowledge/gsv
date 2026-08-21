package com.humansandmachines.gsv.wear.target

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class TargetPathTest {
    @Test
    fun resolvesHomeRelativeAndNormalizedPaths() {
        assertEquals("/home/android", TargetPath.normalize("~"))
        assertEquals("/home/android/notes/today.txt", TargetPath.normalize("~/notes/./today.txt"))
        assertEquals("/home/android/archive/item.txt", TargetPath.normalize("../archive/item.txt", "/home/android/work"))
        assertEquals("/tmp/result", TargetPath.normalize("/home/../../tmp/result"))
    }

    @Test
    fun neverEscapesAboveTheVirtualRoot() {
        assertEquals("/etc/passwd", TargetPath.normalize("../../../../etc/passwd", "/home/android"))
        assertEquals("/", TargetPath.normalize("../../..", "/home/android"))
    }

    @Test
    fun rejectsEmptyNullAndOversizedPaths() {
        assertThrows(IllegalArgumentException::class.java) { TargetPath.normalize(" ") }
        assertThrows(IllegalArgumentException::class.java) { TargetPath.normalize("bad\u0000path") }
        assertThrows(IllegalArgumentException::class.java) { TargetPath.normalize("x".repeat(4_097)) }
    }
}
