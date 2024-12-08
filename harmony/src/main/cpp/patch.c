// hdiff_patch.cpp
#include <napi/native_api.h>
#include "hpatch.h"

#define CHECK_NAPI(env, condition, message) \
    if (!(condition)) { \
        napi_throw_error(env, nullptr, message); \
        return nullptr; \
    }

static napi_value HdiffPatch(napi_env env, napi_callback_info info) {
    // 获取参数
    size_t argc = 2;
    napi_value args[2];
    napi_status status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    CHECK_NAPI(env, status == napi_ok, "Failed to get arguments");
    CHECK_NAPI(env, argc == 2, "Wrong number of arguments");

    // 检查参数类型
    bool isTypedArray;
    status = napi_is_typedarray(env, args[0], &isTypedArray);
    CHECK_NAPI(env, status == napi_ok && isTypedArray, "First argument must be a TypedArray");
    status = napi_is_typedarray(env, args[1], &isTypedArray);
    CHECK_NAPI(env, status == napi_ok && isTypedArray, "Second argument must be a TypedArray");

    //获取原始数据和补丁数据
    uint8_t* originPtr;
    size_t originLength;
    napi_typedarray_type type;
    size_t offset;
    napi_value originBuffer;
    status = napi_get_typedarray_info(env, args[0], &type, &originLength, 
                                     (void**)&originPtr, &originBuffer, &offset);
    CHECK_NAPI(env, status == napi_ok, "Failed to get origin data");

    uint8_t* patchPtr;
    size_t patchLength;
    napi_value patchBuffer;
    status = napi_get_typedarray_info(env, args[1], &type, &patchLength,
                                     (void**)&patchPtr, &patchBuffer, &offset);
    CHECK_NAPI(env, status == napi_ok, "Failed to get patch data");

    // 获取补丁信息
    hpatch_singleCompressedDiffInfo patInfo;
    hpatch_BOOL isError = hpatch_FALSE;
    CHECK_NAPI(env, ((originLength==0)||originPtr) && patchPtr && (patchLength>0),
               "Corrupt patch");
    
    if (kHPatch_ok != hpatch_getInfo_by_mem(&patInfo, patchPtr, patchLength)) {
        napi_throw_error(env, nullptr, "Error info in hpatch");
        return nullptr;
    }
    
    CHECK_NAPI(env, originLength == patInfo.oldDataSize, 
               "Error oldDataSize in hpatch");

    // 创建输出缓冲区
    size_t newsize = (size_t)patInfo.newDataSize;
    if (sizeof(size_t) != sizeof(hpatch_StreamPos_t)) {
        CHECK_NAPI(env, newsize == patInfo.newDataSize,
                   "Error newDataSize in hpatch");
    }

    void* resultData;
    napi_value resultArray;
    status = napi_create_arraybuffer(env, newsize, &resultData, &resultArray);
    CHECK_NAPI(env, status == napi_ok, "Failed to create result buffer");

    // 执行补丁操作
    if (kHPatch_ok != hpatch_by_mem(originPtr, originLength,
                                   (uint8_t*)resultData, newsize,
                                   patchPtr, patchLength, &patInfo)) {
        napi_throw_error(env, nullptr, "Failed to apply patch");
        return nullptr;
    }

    // 创建并返回 Uint8Array
    napi_value result;
    status = napi_create_typedarray(env, napi_uint8_array, newsize, 
                                   resultArray, 0, &result);
    CHECK_NAPI(env, status == napi_ok, "Failed to create result TypedArray");

    return result;
}

// 模块初始化
static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc = {
        "hdiffPatch",      // name
        nullptr,           // method
        HdiffPatch,        // callback
        nullptr,           // getter
        nullptr,           // setter
        nullptr,           // value
        napi_default,      // attributes
        nullptr           // data
    };

    napi_status status = napi_define_properties(env, exports, 1, &desc);
    if (status != napi_ok) {
        napi_throw_error(env, nullptr, "Failed to register function");
        return nullptr;
    }

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)