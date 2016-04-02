//
//  BSDiff.m
//  RCTHotUpdate
//
//  Created by lvbingru on 16/4/2.
//  Copyright © 2016年 erica. All rights reserved.
//

#import "BSDiff.h"

#include <bzlib.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <err.h>
#include <unistd.h>
#include <fcntl.h>
#include "bspatch.h"

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

static int bz2_read(const struct bspatch_stream* stream, void* buffer, int length)
{
    int n;
    int bz2err;
    bz_stream* zip;
    
    zip = (bz_stream*)stream->opaque;
    zip->next_out = (char*)buffer;
    zip->avail_out = length;
    
    int bz2Ret = BZ2_bzDecompress(zip);
    
    if (bz2Ret != BZ_OK && (bz2Ret != BZ_STREAM_END || zip->avail_out > 0))
        return -1;
    
    return 0;
}

static bool bsdiff(const char* oldfile, const char* newfile, const char* patchfile)
{
    FILE * f;
    int fd;
    int bz2err;
    uint8_t header[24];
    uint8_t *old, *new;
    int64_t oldsize, newsize;
    BZFILE* bz2;
    struct bspatch_stream stream;
    
//    if(argc!=4) errx(1,"usage: %s oldfile newfile patchfile\n",argv[0]);
    
    /* Open patch file */
    if ((f = fopen(patchfile, "r")) == NULL) {
        err(1, "fopen(%s)", patchfile);
        return false;
    }
    
    /* Read header */
    if (fread(header, 1, 24, f) != 24) {
        if (feof(f)) {
            errx(1, "Corrupt patch\n");
        }
        err(1, "fread(%s)", patchfile);
        return false;
    }
    
    /* Check for appropriate magic */
    if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) {
        errx(1, "Corrupt patch\n");
        return false;
    }
    
    /* Read lengths from header */
    newsize=offtin(header+16);
    if(newsize<0) {
        errx(1,"Corrupt patch\n");
        return false;
    }
    
    /* Close patch file and re-open it via libbzip2 at the right places */
    if(((fd=open(oldfile,O_RDONLY,0))<0) ||
       ((oldsize=lseek(fd,0,SEEK_END))==-1) ||
       ((old=malloc(oldsize+1))==NULL) ||
       (lseek(fd,0,SEEK_SET)!=0) ||
       (read(fd,old,oldsize)!=oldsize) ||
       (close(fd)==-1)) err(1,"%s",oldfile);
    if((new=malloc(newsize+1))==NULL) err(1,NULL);
    
    if (NULL == (bz2 = BZ2_bzReadOpen(&bz2err, f, 0, 0, NULL, 0))) {
        errx(1, "BZ2_bzReadOpen, bz2err=%d", bz2err);
        return false;
    }
    
    stream.read = bz2_read;
    stream.opaque = bz2;
    if (bspatch(old, oldsize, new, newsize, &stream)) {
        errx(1, "bspatch");
        return false;
    }
    
    /* Clean up the bzip2 reads */
    BZ2_bzReadClose(&bz2err, bz2);
    fclose(f);
    
    /* Write the new file */
    if(((fd=open(newfile,O_CREAT|O_TRUNC|O_WRONLY,0666))<0) ||
       (write(fd,new,newsize)!=newsize) || (close(fd)==-1)) {
        err(1,"%s",newfile);
        return false;
    }
    free(new);
    free(old);
    return true;
}


@implementation BSDiff

+ (BOOL)bsdiffPatch:(NSString *)patch
            origin:(NSString *)origin
      toDestination:(NSString *)destination
{
    if (![[NSFileManager defaultManager] fileExistsAtPath:patch]) {
        return NO;
    }
    if (![[NSFileManager defaultManager] fileExistsAtPath:origin]) {
        return NO;
    }
    
    if ([[NSFileManager defaultManager] fileExistsAtPath:destination]) {
        [[NSFileManager defaultManager] removeItemAtPath:destination error:nil];
    }
    
    bool success = bsdiff([origin UTF8String], [destination UTF8String], [patch UTF8String]);
    return success;
}

@end
