LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE := rnpushy
LOCAL_LDLIBS := -llog

# The shared cores (cpp/patch_core, cpp/update_flow_core, cpp/hpatch) and the
# Android JNI glue (cpp/android_jni) are picked up by directory, so a new
# source file there needs no edit here; tests/ subdirectories are not matched.
# Every include is file-relative (as on iOS), so no include path is needed.
CPP_DIR := $(LOCAL_PATH)/../../cpp
Shared_Files := \
	$(sort $(wildcard $(CPP_DIR)/patch_core/*.cpp)) \
	$(sort $(wildcard $(CPP_DIR)/update_flow_core/*.cpp)) \
	$(sort $(wildcard $(CPP_DIR)/android_jni/*.cpp)) \
	$(sort $(wildcard $(CPP_DIR)/hpatch/*.c))

# HDiffPatch / lzma submodules: only the decoder sources hpatch.c uses.
Hdp_Files := \
	HDiffPatch/libHDiffPatch/HPatch/patch.c \
	HDiffPatch/file_for_patch.c \
	lzma/C/LzmaDec.c \
	lzma/C/Lzma2Dec.c

LOCAL_SRC_FILES := \
	$(patsubst $(LOCAL_PATH)/%,%,$(Shared_Files)) \
	$(Hdp_Files)

include $(BUILD_SHARED_LIBRARY)
