require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
folly_version = '2021.06.28.00-v2'
folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -Wno-comma -Wno-shorten-64-to-32'
Pod::Spec.new do |s|
  s.name         = package['name']
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']

  s.authors      = package['author']
  s.homepage     = package['homepage']

  s.cocoapods_version = '>= 1.6.0'
  s.platform = :ios, "8.0"
  s.platforms = { :ios => "11.0" }
  s.source = { :git => 'https://github.com/reactnativecn/react-native-pushy.git', :tag => '#{s.version}' }
  s.source_files    = "ios/**/*.{h,m,mm,swift}"
  s.libraries = 'bz2', 'z'
  s.vendored_libraries = 'RCTPushy/libRCTPushy.a'
  s.pod_target_xcconfig = { 'USER_HEADER_SEARCH_PATHS' => '"$(SRCROOT)/../node_modules/react-native-update/ios"' }
  s.resource = 'ios/pushy_build_time.txt'
  s.script_phase = { :name => 'Generate build time', :script => 'set -x;date +%s > ${PODS_ROOT}/../../node_modules/react-native-update/ios/pushy_build_time.txt', :execution_position => :before_compile }

  s.dependency 'React'
  s.dependency "React-Core"
  s.dependency 'SSZipArchive'

  s.subspec 'RCTPushy' do |ss|
    ss.source_files = 'ios/RCTPushy/*.{h,m,mm,swift}'
    ss.public_header_files = ['ios/RCTPushy/RCTPushy.h']
  end
  
  s.subspec 'HDiffPatch' do |ss|
    ss.source_files = ['ios/RCTPushy/HDiffPatch/**/*.{h,m,c}',
                       'android/jni/hpatch.{h,c}',
                       'android/jni/HDiffPatch/libHDiffPatch/HPatch/*.{h,c}',
                       'android/jni/HDiffPatch/file_for_patch.{h,c}',
                       'android/jni/lzma/C/LzmaDec.{h,c}',
                       'android/jni/lzma/C/Lzma2Dec.{h,c}']
    ss.private_header_files = 'ios/RCTPushy/HDiffPatch/**/*.h'
  end
  # This guard prevent to install the dependencies when we run `pod install` in the old architecture.
if ENV['RCT_NEW_ARCH_ENABLED'] == '1' then
  s.compiler_flags = folly_compiler_flags + " -DRCT_NEW_ARCH_ENABLED=1"
  s.pod_target_xcconfig    = {
      "HEADER_SEARCH_PATHS" => "\"$(PODS_ROOT)/boost\"",
      "CLANG_CXX_LANGUAGE_STANDARD" => "c++17"
  }

  s.dependency "React-Codegen"
  s.dependency "RCT-Folly", folly_version
  s.dependency "RCTRequired"
  s.dependency "RCTTypeSafety"
  s.dependency "ReactCommon/turbomodule/core"
end
end
