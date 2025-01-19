#!/bin/bash

PROJECT_NAME=$(echo "$CONFIGURATION_BUILD_DIR" | sed -n 's/.*DerivedData\/\([^-]*\).*/\1/p')

CONFIGURATION_BUILD_DIR="$(dirname "$CONFIGURATION_BUILD_DIR")/Release-iphonesimulator/$PROJECT_NAME.app"

SOURCE_ASSETS="$CONFIGURATION_BUILD_DIR/assets"
SOURCE_BUNDLE="$CONFIGURATION_BUILD_DIR/main.jsbundle"

PROJECT_ROOT="$PROJECT_DIR"
TARGET_DIR="$PROJECT_ROOT/../.pushy/intermedia/ios"
TARGET_ASSETS="$TARGET_DIR/assets"

mkdir -p "$TARGET_DIR"

echo "开始拷贝React Native资源文件..."

if [ -d "$SOURCE_ASSETS" ]; then
  echo "正在拷贝assets..."
  rm -rf "$TARGET_ASSETS"
  cp -R "$SOURCE_ASSETS" "$TARGET_DIR/"
else
  echo "警告: assets文件夹不存在于源目录"
fi

if [ -f "$SOURCE_BUNDLE" ]; then
  echo "正在拷贝并重命名bundle文件..."
  cp "$SOURCE_BUNDLE" "$TARGET_DIR/index.bundlejs"
else
  echo "警告: main.jsbundle文件不存在于源目录"
fi

echo "资源文件拷贝完成!"