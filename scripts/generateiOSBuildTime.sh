  
#!/bin/bash
set -x
# DEST=$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH
# date +%s > "$DEST/pushy_build_time.txt"
OLD_TEXT="NSString \*pushy_build_time"
NEW_TEXT="    NSString \*pushy_build_time = $(date +%s)"
TARGET_FILE="../../node_modules/react-native-update/ios/RCTHotUpdate/RCTHotUpdate.m"
sed -i '' -e "s/.*$OLD_TEXT.*/$NEW_TEXT/" "$TARGET_FILE"