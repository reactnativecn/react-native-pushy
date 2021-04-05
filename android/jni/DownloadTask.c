//
// Created by DengYun on 3/31/16.
//

#include "cn_reactnative_modules_update_DownloadTask.h"
#include <stdlib.h>
#include "bzlib.h"
#include "bspatch.h"
#include <string.h> //for memcmp
#include <android/log.h>

#include "hpatch.h"

static int64_t offtin(uint8_t *buf)
{
    int64_t y;

    y=buf[7]&0x7F;
    y=y*256;y+=buf[6];
    y=y*256;y+=buf[5];
    y=y*256;y+=buf[4];
    y=y*256;y+=buf[3];
    y=y*256;y+=buf[2];
    y=y*256;y+=buf[1];
    y=y*256;y+=buf[0];

    if(buf[7]&0x80) y=-y;

    return y;
}

const size_t BUFFER_SIZE = 4096;

static int bz2_read(const struct bspatch_stream* stream, void* buffer, int length)
{
    int n;
    int bz2err;
    bz_stream* zip;

    if (length == 0) {
      return 0;
    }

    zip = (bz_stream*)stream->opaque;
    zip->next_out = (char*)buffer;
    zip->avail_out = length;

    int bz2Ret = BZ2_bzDecompress(zip);

    if (bz2Ret != BZ_OK && (bz2Ret != BZ_STREAM_END || zip->avail_out > 0))
        return -1;

    return 0;
}

JNIEXPORT jbyteArray JNICALL Java_cn_reactnative_modules_update_DownloadTask_bsdiffPatch
        (JNIEnv *env, jobject self, jbyteArray origin, jbyteArray patch){
    jclass newExcCls;
    jbyte* outPtr;
    struct bspatch_stream stream;
    bz_stream zip;

    jbyte* originPtr = (*env)->GetByteArrayElements(env, origin, NULL);
    size_t originLength = (*env)->GetArrayLength(env, origin);
    jbyte* patchPtr = (*env)->GetByteArrayElements(env, patch, NULL);
    size_t patchLength = (*env)->GetArrayLength(env, patch);
    jbyteArray ret = NULL;

    if (patchLength < 32) {
        newExcCls = (*env)->FindClass(env,"java/lang/Error");
        if (newExcCls != NULL) /* Unable to find the new exception class, give up. */
            (*env)->ThrowNew(env,newExcCls, "Corrupt patch");
        (*env)->ReleaseByteArrayElements(env, origin, originPtr, JNI_ABORT);
        (*env)->ReleaseByteArrayElements(env, patch, patchPtr, JNI_ABORT);
        return NULL;
    }
    int64_t newsize=offtin((uint8_t*)patchPtr + 16);
    if (memcmp(patchPtr, "ENDSLEY/BSDIFF43", 16) != 0 || newsize<0) {
        newExcCls = (*env)->FindClass(env, "java/lang/Error");
        if (newExcCls != NULL) /* Unable to find the new exception class, give up. */
            (*env)->ThrowNew(env, newExcCls, "Corrupt patch");
        (*env)->ReleaseByteArrayElements(env, origin, originPtr, JNI_ABORT);
        (*env)->ReleaseByteArrayElements(env, patch, patchPtr, JNI_ABORT);
        return NULL;
    }
    ret = (*env)->NewByteArray(env, newsize);
    if (ret == NULL) {
        return NULL; //  out of memory error thrown
    }
    outPtr = (*env)->GetByteArrayElements(env, ret, NULL);

    zip.bzalloc = NULL;
    zip.bzfree = NULL;
    zip.opaque = NULL;
    BZ2_bzDecompressInit(&zip, 0, 1);

    zip.next_in = (char*)patchPtr + 32;
    zip.avail_in = patchLength - 32;

    stream.read = bz2_read;
    stream.opaque = &zip;
    if (bspatch((const uint8_t*)originPtr, originLength, (uint8_t*)outPtr, newsize, &stream)) {
        newExcCls = (*env)->FindClass(env, "java/lang/Error");
        if (newExcCls != NULL) /* Unable to find the new exception class, give up. */
            (*env)->ThrowNew(env, newExcCls, "bspatch");
    }

    BZ2_bzDecompressEnd(&zip);

    (*env)->ReleaseByteArrayElements(env, ret, outPtr, 0);
    (*env)->ReleaseByteArrayElements(env, origin, originPtr, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, patch, patchPtr, JNI_ABORT);
    return ret;
}


#define _check(v,errInfo) do{ if (!(v)) {  _isError=hpatch_TRUE; _errInfo=errInfo; goto _clear;  } }while(0)

JNIEXPORT jbyteArray JNICALL Java_cn_reactnative_modules_update_DownloadTask_hdiffPatch
        (JNIEnv *env, jobject self, jbyteArray origin, jbyteArray patch){
    hpatch_BOOL  _isError=hpatch_FALSE; 
    const char* _errInfo="";

    jbyte* originPtr = (*env)->GetByteArrayElements(env, origin, NULL);
    size_t originLength = (*env)->GetArrayLength(env, origin);
    jbyte* patchPtr = (*env)->GetByteArrayElements(env, patch, NULL);
    size_t patchLength = (*env)->GetArrayLength(env, patch);
    jbyteArray ret = NULL;
    jbyte* outPtr = NULL;
    size_t newsize = 0;
    hpatch_singleCompressedDiffInfo patInfo;

    _check(((originLength==0)||originPtr) && patchPtr && (patchLength>0),"Corrupt patch");
    _check(0!=hpatch_getInfo_by_mem(&patInfo,(const uint8_t*)patchPtr,patchLength),"Error info in hpatch");
    _check(originLength==patInfo.oldDataSize,"Error oldDataSize in hpatch");
    newsize=(size_t)patInfo.newDataSize;
    if (sizeof(size_t)!=sizeof(hpatch_StreamPos_t))
        _check(newsize==patInfo.newDataSize,"Error newDataSize in hpatch");
    
    ret = (*env)->NewByteArray(env,newsize);
    _check(ret,"Error JNIEnv::NewByteArray()");
    if (newsize>0) {
        outPtr = (*env)->GetByteArrayElements(env, ret, NULL);
        _check(outPtr,"Corrupt JNIEnv::GetByteArrayElements");
    }

    _check(0!=hpatch_by_mem((const uint8_t*)originPtr,originLength,(uint8_t*)outPtr,newsize,
                            (const uint8_t*)patchPtr,patchLength,&patInfo),"hpacth");

_clear:
    if (outPtr) (*env)->ReleaseByteArrayElements(env, ret, outPtr, (_isError?JNI_ABORT:0));
    if (originPtr) (*env)->ReleaseByteArrayElements(env, origin, originPtr, JNI_ABORT);
    if (patchPtr) (*env)->ReleaseByteArrayElements(env, patch, patchPtr, JNI_ABORT);
    if (_isError){
        jclass newExcCls = NULL;
        if (ret){
            (*env)->DeleteLocalRef(env, ret);
            ret = NULL;
        }
        newExcCls = (*env)->FindClass(env, "java/lang/Error");
        if (newExcCls != NULL) // Unable to find the new exception class, give up.
            (*env)->ThrowNew(env, newExcCls, _errInfo);
    }
    return ret;
}
