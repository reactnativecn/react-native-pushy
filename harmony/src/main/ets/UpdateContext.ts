import preferences from '@ohos.data.preferences';
import bundleManager from '@ohos.bundle.bundleManager';
import fileIo from '@ohos.file.fs';
import { DownloadTask } from './DownloadTask';
import { DownloadTaskParams } from './DownloadTaskParams';

export class UpdateContext {
    private context: Context;
    private rootDir: string;
    private preferences: preferences.Preferences;
    private static DEBUG: boolean = false;
    private static isUsingBundleUrl: boolean = false;

    constructor(context: Context) {
        this.context = context;
        this.rootDir = context.filesDir + '/_update';
        
        try {
            if (!fileIo.accessSync(this.rootDir)) {
                fileIo.mkdirSync(this.rootDir);
            }
        } catch (e) {
            console.error('Failed to create root directory:', e);
        }

        this.initPreferences();
    }

    private async initPreferences() {
        try {
            this.preferences = await preferences.getPreferences(this.context, 'update');
            const packageVersion = await this.getPackageVersion();
            const storedVersion = await this.preferences.get('packageVersion', '');
            
            if (packageVersion !== storedVersion) {
                await this.preferences.clear();
                await this.preferences.put('packageVersion', packageVersion);
                await this.preferences.flush();
                this.cleanUp();
            }
        } catch (e) {
            console.error('Failed to init preferences:', e);
        }
    }

    public async setKv(key: string, value: string): Promise<void> {
        await this.preferences.put(key, value);
        await this.preferences.flush();
    }

    public async getKv(key: string): Promise<string> {
        return await this.preferences.get(key, '') as string;
    }

    public async isFirstTime(): Promise<boolean> {
        return await this.preferences.get('firstTime', false) as boolean;
    }

    public async rolledBackVersion(): Promise<string> {
        return await this.preferences.get('rolledBackVersion', '') as string;
    }

    public async markSuccess(): Promise<void> {
        await this.preferences.put('firstTimeOk', true);
        const lastVersion = await this.preferences.get('lastVersion', '') as string;
        const curVersion = await this.preferences.get('currentVersion', '') as string;
        
        if (lastVersion && lastVersion !== curVersion) {
            await this.preferences.delete('lastVersion');
            await this.preferences.delete(`hash_${lastVersion}`);
        }
        await this.preferences.flush();
        this.cleanUp();
    }

    public clearFirstTime(): void {
        this.preferences.putSync('firstTime', false);
        this.preferences.flush();
        this.cleanUp();
    }

    public clearRollbackMark(): void {
        this.preferences.putSync('rolledBackVersion', null);
        this.preferences.flush();
        this.cleanUp();
    }

    public async downloadFullUpdate(url: string, hash: string, listener: DownloadFileListener): Promise<void> {
        try {
            const params = new DownloadTaskParams();
            params.type = DownloadTaskParams.TASK_TYPE_PATCH_FULL;
            params.url = url;
            params.hash = hash;
            params.listener = listener;
            params.targetFile = `${this.rootDir}/${hash}.ppk`;
            const downloadTask = new DownloadTask(this.context);
            await downloadTask.execute(params);
        } catch (e) {
            console.error('Failed to download full update:', e);
        }
    }

    public async downloadFile(url: string, hash: string, fileName: string, listener: DownloadFileListener): Promise<void> {
        const params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD;
        params.url = url;
        params.hash = hash;
        params.listener = listener;
        params.targetFile = this.rootDir + '/' + fileName;

        const downloadTask = new DownloadTask(this.context);
        await downloadTask.execute(params);
    }

    public async downloadPatchFromPpk(url: string, hash: string, originHash: string, listener: DownloadFileListener): Promise<void> {
        const params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
        params.url = "https://github.com/bozaigao/harmony_use_video/raw/refs/heads/main/diff.ppk-patch";
        params.hash = hash;
        params.originHash = originHash;
        params.listener = listener;
        params.targetFile = `${this.rootDir}/${originHash}_${hash}.ppk.patch`;
        params.unzipDirectory = `${this.rootDir}/${hash}`;
        params.originDirectory = `${this.rootDir}/${originHash}`;
        
        const downloadTask = new DownloadTask(this.context);
        await downloadTask.execute(params);
    }

    public async downloadPatchFromApk(url: string, hash: string, listener: DownloadFileListener): Promise<void> {
        try {
            const params = new DownloadTaskParams();
            params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK;
            params.url = url;
            params.hash = hash;
            params.listener = listener;
            params.targetFile = `${this.rootDir}/${hash}.apk.patch`;
            params.unzipDirectory = `${this.rootDir}/${hash}`;

            const downloadTask = new DownloadTask(this.context);
            await downloadTask.execute(params);
        } catch (e) {
            console.error('Failed to download APK patch:', e);
        }
    }

    public async switchVersion(hash: string): Promise<void> {
        try {
            const bundlePath = `${this.rootDir}/${hash}/index.bundlejs`;
            if (!fileIo.accessSync(bundlePath)) {
                throw new Error(`Bundle version ${hash} not found.`);
            }

            const lastVersion = await this.getKv('currentVersion');
            await this.setKv('currentVersion', hash);

            if (lastVersion && lastVersion !== hash) {
                await this.setKv('lastVersion', lastVersion);
            }

            await this.setKv('firstTime', 'true');
            await this.setKv('firstTimeOk', 'false');
            await this.setKv('rolledBackVersion', null);
        } catch (e) {
            console.error('Failed to switch version:', e);
        }
    }

    public static getBundleUrl(context: Context, defaultAssetsUrl?: string): string {
        return new UpdateContext(context).getBundleUrl(defaultAssetsUrl);
    }

    public getBundleUrl(defaultAssetsUrl?: string): string {
        UpdateContext.isUsingBundleUrl = true;
        const currentVersion = this.getCurrentVersion();
        if (!currentVersion) {
            return defaultAssetsUrl;
        }

        if (!this.isFirstTime()) {
            if (!this.preferences.get('firstTimeOk', true)) {
                return this.rollBack();
            }
        }

        let version = currentVersion;
        while (version) {
            const bundleFile = `${this.rootDir}/${version}/index.bundlejs`;
            try {
                if (!fileIo.accessSync(bundleFile)) {
                    console.error(`Bundle version ${version} not found.`);
                    version = this.rollBack();
                    continue;
                }
                return bundleFile;
            } catch (e) {
                console.error('Failed to access bundle file:', e);
                version = this.rollBack();
            }
        }

        return defaultAssetsUrl;
    }

    getPackageVersion(): string {
        let bundleFlags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
        let packageVersion = '';
        try {
            const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleFlags);
            packageVersion = bundleInfo?.versionName || "Unknown";
        } catch (error) {
            console.error("获取包信息失败:", error);
        }
        return packageVersion;
    }

    public getCurrentVersion() : string {
        const currentVersion = this.preferences.getSync('currentVersion', '') as string;
        return currentVersion;
    }

    private rollBack(): string {
        const lastVersion = this.preferences.getSync('lastVersion', '') as string;
        const currentVersion = this.preferences.getSync('currentVersion', '') as string;
        if (!lastVersion) {
            this.preferences.deleteSync('currentVersion');
        } else {
            this.preferences.putSync('currentVersion', lastVersion);
        }
         this.preferences.putSync('firstTimeOk', true);
         this.preferences.putSync('firstTime', false);
         this.preferences.putSync('rolledBackVersion', currentVersion);
         this.preferences.flush();
        return lastVersion;
    }

    private cleanUp(): void {
        const params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_CLEANUP;
        params.hash =  this.preferences.getSync('currentVersion', '') as string;
        params.originHash =  this.preferences.getSync('lastVersion', '') as string;
        params.unzipDirectory = this.rootDir;
        const downloadTask = new DownloadTask(this.context);
        downloadTask.execute(params);
    }

    public getIsUsingBundleUrl(): boolean {
        return UpdateContext.isUsingBundleUrl;
    }
}

export interface DownloadFileListener {
    onDownloadCompleted(params: DownloadTaskParams): void;
    onDownloadFailed(error: Error): void;
}