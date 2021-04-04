// hpatch.c
// Copyright 2021 housisong, All rights reserved
#include "hpatch.h"
#include "HDiffPatch/libHDiffPatch/HPatch/patch.h"
#include "HDiffPatch/file_for_patch.h"

enum {
    kHPatch_ok                  = 0,
    kHPatch_error_info          =-1,
    kHPatch_error_old_fopen     =-2,
    kHPatch_error_old_fread     =-3,
    kHPatch_error_old_fclose    =-4,
    kHPatch_error_pat_fopen     =-5,
    kHPatch_error_pat_fread     =-6,
    kHPatch_error_pat_fclose    =-7,
    kHPatch_error_new_fopen     =-8,
    kHPatch_error_new_fwrite    =-9,
    kHPatch_error_new_fclose    =-10,
};

#define  _check(v,errorType) do{ \
    if (!(v)){ if (result==kHPatch_ok) result=errorType; if (!_isInClear){ goto _clear; }; } }while(0)

int hpatch_getInfo_by_mem(struct hpatch_singleCompressedDiffInfo* out_patinfo,
                          const uint8_t* pat,size_t patsize){
    hpatch_TStreamInput patStream;
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    if (!getSingleCompressedDiffInfo(out_patinfo,&patStream,0))
        return kHPatch_error_info;//data error;
    return kHPatch_ok; //ok              
}


static int hpatch_by_stream(const hpatch_TStreamInput* old,hpatch_BOOL isLoadOldToMem,const hpatch_TStreamInput* pat,
                            hpatch_TStreamOutput* out_new,const hpatch_singleCompressedDiffInfo* patInfo){
//todo:
    return -1;
}

int hpatch_by_mem(const uint8_t* old,size_t oldsize,uint8_t* newBuf,size_t newsize,
                  const uint8_t* pat,size_t patsize,const struct hpatch_singleCompressedDiffInfo* patInfo){      
    hpatch_TStreamInput oldStream;
    hpatch_TStreamInput patStream;
    hpatch_TStreamOutput newStream;
    mem_as_hStreamInput(&oldStream,old,old+oldsize);
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    mem_as_hStreamOutput(&newStream,newBuf,newBuf+newsize);
    return hpatch_by_stream(&oldStream,hpatch_FALSE,&patStream,&newStream,patInfo);
}

int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile){
    int     result=kHPatch_ok;
    int     _isInClear=hpatch_FALSE;
    int     patch_result;
    hpatch_TFileStreamInput oldStream;
    hpatch_TFileStreamInput patStream;
    hpatch_TFileStreamOutput newStream;
    hpatch_TFileStreamInput_init(&oldStream);
    hpatch_TFileStreamInput_init(&patStream);
    hpatch_TFileStreamOutput_init(&newStream);

    _check(hpatch_TFileStreamInput_open(&oldStream,oldfile),kHPatch_error_old_fopen);
    _check(hpatch_TFileStreamInput_open(&patStream,patchfile),kHPatch_error_pat_fopen);
    _check(hpatch_TFileStreamOutput_open(&newStream,newfile,~(hpatch_StreamPos_t)0),kHPatch_error_new_fopen);

    patch_result=hpatch_by_stream(&oldStream.base,hpatch_TRUE,&patStream.base,&newStream.base,0);
    if (patch_result!=kHPatch_ok){
        _check(!oldStream.fileError,kHPatch_error_old_fread);
        _check(!patStream.fileError,kHPatch_error_pat_fread);
        _check(!newStream.fileError,kHPatch_error_new_fwrite);
        _check(hpatch_FALSE,patch_result);
    }

_clear:
    _isInClear=hpatch_TRUE;
    _check(hpatch_TFileStreamInput_close(&oldStream),kHPatch_error_old_fclose);
    _check(hpatch_TFileStreamInput_close(&patStream),kHPatch_error_pat_fclose);
    _check(hpatch_TFileStreamOutput_close(&newStream),kHPatch_error_new_fclose);
    return result;
}
