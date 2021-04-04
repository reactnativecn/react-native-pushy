// hpatch.h 
// import HDiffPatch, support patchfile created by "hdiffz -SD -C-lzma2 oldfile newfile patchfile" 
// Copyright 2021 housisong, All rights reserved

#ifndef HDIFFPATCH_PATCH_H
#define HDIFFPATCH_PATCH_H
# include <stdint.h> //for uint8_t

int hpatch_by_mem(const uint8_t* old,size_t oldsize, uint8_t* newBuf,size_t newsize,
                  const uint8_t* pat,size_t patsize);
int hpatch_by_file(const char* oldfile, const char* newfile, const char* patchfile);

#endif //HDIFFPATCH_PATCH_H