// hpatch.c
// Copyright 2021 housisong, All rights reserved
#include "hpatch.h"
#include "HDiffPatch/libHDiffPatch/HPatch/patch.h"
#include "HDiffPatch/file_for_patch.h"

enum {
    kHPatch_ok          = 0,
    kHPatch_error_info  =-1,
};

int hpatch_getInfo_by_mem(struct hpatch_singleCompressedDiffInfo* out_patinfo,
                          const uint8_t* pat,size_t patsize){
    hpatch_TStreamInput patStream;
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    if (!getSingleCompressedDiffInfo(out_patinfo,&patStream,0))
        return kHPatch_error_info;//data error;
    return kHPatch_ok; //ok              
}


static int hpatch_by_stream(const hpatch_TStreamInput* old,const hpatch_TStreamInput* pat,
                            const hpatch_TStreamOutput* out_new,const hpatch_singleCompressedDiffInfo* patInfo){
//
}

int hpatch_by_mem(const uint8_t* old,size_t oldsize,uint8_t* newBuf,size_t newsize,
                  const uint8_t* pat,size_t patsize,const struct hpatch_singleCompressedDiffInfo* patInfo){
    hpatch_TStreamInput oldStream;
    hpatch_TStreamInput patStream;
    hpatch_TStreamOutput newStream;
    mem_as_hStreamInput(&oldStream,old,old+oldsize);
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    mem_as_hStreamOutput(&newStream,newBuf,newBuf+newsize);
    return hpatch_by_stream(&oldStream,&patStream,&newStream,patInfo);
}

int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile){
    //todo:
    return -1;
}