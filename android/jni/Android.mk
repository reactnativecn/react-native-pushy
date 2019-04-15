LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE := rnupdate
LOCAL_SRC_FILES := \
	DownloadTask.c \
	blocksort.c \
	bspatch.c \
	bzlib.c \
	crctable.c \
	compress.c \
	decompress.c \
	huffman.c \
	randtable.c

include $(BUILD_SHARED_LIBRARY)