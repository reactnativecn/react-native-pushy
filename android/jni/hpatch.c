// hpatch.c
// Copyright 2021 housisong, All rights reserved
#include "hpatch.h"
#include "HDiffPatch/libHDiffPatch/HPatch/patch.h"

int hpatch_getInfo_by_mem(struct hpatch_singleCompressedDiffInfo* out_patinfo,
                          const uint8_t* pat,size_t patsize){
    hpatch_TStreamInput patStream;
    mem_as_hStreamInput(&patStream,pat,pat+patsize);
    if (!getSingleCompressedDiffInfo(out_patinfo,&patStream,0))
        return -1;//data error;
    return 0; //ok              
}

int hpatch_by_mem(const uint8_t* old,size_t oldsize, uint8_t* newBuf,size_t newsize,
                  const uint8_t* pat,size_t patsize,const struct hpatch_singleCompressedDiffInfo* patInfo){
    //todo:
    return -1;
}

int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile){
    //todo:
    return -1;
}