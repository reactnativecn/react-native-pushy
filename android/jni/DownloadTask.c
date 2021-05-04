//
// Created by DengYun on 3/31/16.
//

#include "cn_reactnative_modules_update_DownloadTask.h"

#include "hpatch.h"
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
    _check(kHPatch_ok==hpatch_getInfo_by_mem(&patInfo,(const uint8_t*)patchPtr,patchLength),"Error info in hpatch");
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

    _check(kHPatch_ok==hpatch_by_mem((const uint8_t*)originPtr,originLength,(uint8_t*)outPtr,newsize,
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
