LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE := rnupdate

Hdp_Files := \
	hpatch.c \
    HDiffPatch/libHDiffPatch/HPatch/patch.c \
	HDiffPatch/file_for_patch.c \
	lzma/C/LzmaDec.c \
    lzma/C/Lzma2Dec.c

LOCAL_SRC_FILES := \
	DownloadTask.c \
	$(Hdp_Files)

include $(BUILD_SHARED_LIBRARY)