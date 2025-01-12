import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import fs from 'fs';
import path from 'path';

export function generatePushyBuildTime(str?: string) {
    return {
        pluginId: 'PushyBuildTimePlugin',
        apply(pluginContext) {
            pluginContext.registerTask({
                name: 'pushy_build_time',
                run: (taskContext) => {
                    const metaFilePath = path.resolve(__dirname, 'src/main/resources/rawfile/meta.json');
                    const dirPath = path.dirname(metaFilePath);
                    if (!fs.existsSync(dirPath)) {
                        fs.mkdirSync(dirPath, { recursive: true });
                    }
                    const moduleJsonPath = path.resolve(__dirname, '../AppScope/app.json5');
                    let versionName = '';
                    if (fs.existsSync(moduleJsonPath)) {
                        const moduleContent = fs.readFileSync(moduleJsonPath, 'utf-8');
                        const versionMatch = moduleContent.match(/"versionName":\s*"([^"]+)"/);
                        if (versionMatch && versionMatch[1]) {
                            versionName = versionMatch[1];
                        }
                    }
                    const buildTime = new Date().toISOString();
                    const metaContent = { 
                        pushy_build_time: buildTime,
                        versionName: versionName 
                    };
                    fs.writeFileSync(metaFilePath, JSON.stringify(metaContent, null, 4));
                    console.log(`Build time written to ${metaFilePath}`);
                },
                dependencies: [],
                postDependencies: ['default@BuildJS']
            })
        }
    }
}

export default {
    system: hapTasks,  /* Built-in plugin of Hvigor. It cannot be modified. */
    plugins:[generatePushyBuildTime()]         /* Custom plugin to extend the functionality of Hvigor. */
}
