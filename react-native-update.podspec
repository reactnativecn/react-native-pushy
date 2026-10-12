require 'json'
require 'rubygems' # Required for version comparison

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
podspec_dir = File.dirname(__FILE__)

Pod::Spec.new do |s|

  is_expo_in_podfile = false
  begin
    # Check Podfile for use_expo_modules!
    podfile_path = File.join(Pod::Config.instance.installation_root, 'Podfile')
    if File.exist?(podfile_path)
      podfile_content = File.read(podfile_path)
      is_expo_in_podfile = podfile_content.include?('use_expo_modules!')
    end
  rescue => e
     # Silently ignore errors during check
  end

  # One node call answers every Expo question: expo's version, and where
  # expo-modules-core lives and its version. expo-modules-core is a dependency
  # of expo, not of the app: resolve it from expo's own location. A bare
  # require from this podspec's directory misses it when npm nests it under
  # expo/node_modules (seen with react-native-tvos), which left
  # EXPO_SUPPORTS_BUNDLEURL unset; the createBridge fallback that selects no
  # longer exists in ExpoModulesCore (SDK 57), so the build failed.
  expo_info = {}
  if is_expo_in_podfile
    expo_info_js = <<~JS
      const path = require('path');
      const info = {};
      try {
        const expoJson = require.resolve('expo/package.json');
        info.expoVersion = require(expoJson).version;
        const coreJson = require.resolve('expo-modules-core/package.json',
                                         { paths: [path.dirname(expoJson)] });
        info.coreDir = path.dirname(coreJson);
        info.coreVersion = require(coreJson).version;
      } catch (e) {}
      console.log(JSON.stringify(info));
    JS
    begin
      output = IO.popen(['node', '-e', expo_info_js], &:read)
      expo_info = JSON.parse(output) if $?.success?
    rescue StandardError
      # node missing or unparseable output: not a supported Expo project.
    end
  end

  # use_expo_modules! in the Podfile and Expo SDK >= 50.
  valid_expo_project =
    is_expo_in_podfile && expo_info['expoVersion'].to_s[/^\d+/].to_i >= 50

  # Set platform based on whether it's a valid Expo project and if we can parse its target
  # React Native's own minimum (defined by react_native_pods.rb, which the
  # Podfile loads before evaluating podspecs). The pod platform version also
  # becomes the deployment target of the privacy resource bundle target,
  # which React Native's post_install does not raise: Xcode 27 rejects
  # anything below 15.0 there, so a hard-coded 11.0 fails the build.
  final_ios_deployment_target =
    defined?(min_ios_version_supported) ? min_ios_version_supported : '11.0'
  # tvOS has its own version line: react-native-tvos reports it through
  # min_supported_versions[:tvos] (stock React Native has no :tvos entry).
  # 15.1 is react-native-tvos's own floor since 0.76, and clears the same
  # Xcode 27 resource-bundle minimum as iOS.
  final_tvos_deployment_target = begin
    defined?(min_supported_versions) ? min_supported_versions[:tvos] : nil
  rescue StandardError
    nil
  end
  final_tvos_deployment_target ||= '15.1'

  if valid_expo_project
    # --- Try to find and parse ExpoModulesCore.podspec only if it's an Expo project ---
    parsed_expo_ios_target = nil
    parsed_expo_tvos_target = nil
    expo_modules_core_podspec_path =
      expo_info['coreDir'] && File.join(expo_info['coreDir'], 'ExpoModulesCore.podspec')

    if expo_modules_core_podspec_path && File.exist?(expo_modules_core_podspec_path)
      begin
        content = File.read(expo_modules_core_podspec_path)
        match = content.match(/s\.platforms\s*=\s*\{[\s\S]*?:ios\s*=>\s*'([^\']+)'/) # Match within s.platforms hash
        if match && match[1]
          parsed_expo_ios_target = match[1]
          tvos_match = content.match(/s\.platforms\s*=\s*\{[\s\S]*?:tvos\s*=>\s*'([^\']+)'/)
          parsed_expo_tvos_target = tvos_match[1] if tvos_match
        end
      rescue => e
        # Pod::UI.warn "Failed to read or parse ExpoModulesCore.podspec content: #{e.message}"
      end
    end
    if parsed_expo_ios_target
        final_ios_deployment_target = parsed_expo_ios_target
    end
    if parsed_expo_tvos_target
        final_tvos_deployment_target = parsed_expo_tvos_target
    end
  end

  # tvOS (react-native-tvos) shares the iOS sources; the only platform
  # differences live behind TARGET_OS_TV in ios/RCTPushy (download directory,
  # purged-cache recovery).
  s.platforms = { :ios => final_ios_deployment_target, :tvos => final_tvos_deployment_target }

  s.name         = package['name']
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']

  s.authors      = package['author']
  s.homepage     = package['homepage']

  s.cocoapods_version = '>= 1.6.0'

  s.source = { :git => 'https://github.com/reactnativecn/react-native-update.git', :tag => "#{s.version}" }

  s.libraries = 'bz2', 'z'
  # tvOS checks for a network path before blocking a launch on the
  # purged-version restore (nw_path_monitor).
  s.tvos.frameworks = 'Network'
  # No search path into the pod source: every include under ios/ resolves
  # relative to the including file (the cpp/ core via ../../cpp/...), and the
  # former absolute "#{podspec_dir}/ios" entry made the generated xcconfig
  # machine-specific.
  # DEFINES_MODULE writes the umbrella under Headers/Public/react_native_update/
  # (underscores). CocoaPods copies public headers to react-native-update/
  # (hyphens). Include the latter so the umbrella can #import "ImportReact.h".
  s.pod_target_xcconfig = {
    'USER_HEADER_SEARCH_PATHS' => "\"$(PODS_ROOT)/Headers/Public/react-native-update\"",
    "DEFINES_MODULE" => "YES"
  }
  # buildTime for binary-rebuild detection (SyncBinaryVersion) and the check
  # request. The stamp is refreshed on every build and ships as a resource.
  # When the pod source is not writable (read-only checkout or cache) the
  # committed value is kept; +buildTime falls back to the main bundle's
  # Info.plist mtime when the file is missing or empty, so it is never blank.
  s.resource = 'ios/pushy_build_time.txt'
  build_time_phase = {
    :name => 'Generate build time',
    :script => "set -x; f=\"${PODS_TARGET_SRCROOT:-#{podspec_dir}}/ios/pushy_build_time.txt\"; if [ -w \"$f\" ] || { [ ! -e \"$f\" ] && [ -w \"$(dirname \"$f\")\" ]; }; then date +%s > \"$f\"; else echo \"warning: $f is not writable, keeping the shipped build time\"; fi",
    :execution_position => :before_compile
  }
  # Declaring the output lets Xcode order the resource copy (into the app, or
  # into this pod's framework under use_frameworks!) after the stamp is
  # written and stops the output-less-phase warning. A phase with outputs and
  # no inputs is otherwise skipped once the file exists — and it is committed
  # — so the phase must also be marked always out of date to keep refreshing
  # the stamp every build. CocoaPods < 1.11 has no such key; there the phase
  # stays output-less (runs every build, as before).
  if defined?(Pod::Specification::DSL::SCRIPT_PHASE_OPTIONAL_KEYS) &&
     Pod::Specification::DSL::SCRIPT_PHASE_OPTIONAL_KEYS.include?(:always_out_of_date)
    build_time_phase[:output_files] = ['$(PODS_TARGET_SRCROOT)/ios/pushy_build_time.txt']
    build_time_phase[:always_out_of_date] = '1'
  end
  s.script_phase = build_time_phase
  # Privacy manifest (required-reason APIs: disk space, file timestamps,
  # system boot time, user defaults) delivered as its own resource bundle so
  # static and dynamic integrations both carry it.
  s.resource_bundles = { 'PushyPrivacy' => ['ios/PrivacyInfo.xcprivacy'] }

  s.dependency "React-Core"
  # The unzip guard relies on the 2.x delegate contract
  # (zipArchiveShouldUnzipFileAtIndex:... cancels, _sanitizedPath); a future
  # major could change it silently.
  s.dependency 'SSZipArchive', '~> 2.4'

  # Conditionally add Expo dependency
  if valid_expo_project
    # DEFINES_MODULE lists public headers in the umbrella. Marking
    # ImportReact.h public without source_files leaves it out of
    # Headers/Public, so compiling the Swift module fails.
    s.source_files = 'ios/ImportReact.h'
    s.public_header_files = ['ios/ImportReact.h']
    s.dependency 'ExpoModulesCore'
  end

  # Shared C/C++ core. Built with hidden visibility so none of its symbols are
  # exported when the pod is linked as a dynamic framework. Per-file flags: the
  # Objective-C classes in the RCTPushy subspec keep default visibility, which
  # the host app and the Expo module need to link against RCTPushy.
  s.subspec 'Core' do |ss|
    # The cores are picked up by directory (non-recursive: tests/ stays out,
    # and the Android JNI glue lives in cpp/android_jni), so a new
    # platform-neutral source needs no edit here.
    ss.source_files = ['cpp/patch_core/*.{h,cpp}',
                       'cpp/update_flow_core/*.{h,cpp}',
                       'cpp/hpatch/*.{h,c}',
                       'android/jni/HDiffPatch/libHDiffPatch/HPatch/*.{h,c}',
                       'android/jni/HDiffPatch/file_for_patch.{h,c}',
                       'android/jni/lzma/C/LzmaDec.{h,c}',
                       'android/jni/lzma/C/Lzma2Dec.{h,c}']
    ss.private_header_files = ['cpp/**/*.h', 'android/jni/**/*.h']
    # NDEBUG matches the prebuilt Android library and keeps third-party assertion
    # text (file and expression strings) out of the binary.
    ss.compiler_flags = '-DNDEBUG -fvisibility=hidden -fvisibility-inlines-hidden'
  end

  s.subspec 'RCTPushy' do |ss|
    ss.dependency 'react-native-update/Core'
    ss.source_files = ['ios/RCTPushy/*.{h,m,mm}']
    ss.public_header_files = ['ios/RCTPushy/RCTPushy.h',
                              'ios/RCTPushy/RCTPushyConfiguration.h',
                              'ios/RCTPushy/RCTPushyDownloader.h']
    # Shared by the pod's own sources only (RCTPushyInternal.h pulls in C++
    # headers), so they must stay out of the module umbrella.
    ss.private_header_files = ['ios/RCTPushy/RCTPushyCommon.h',
                               'ios/RCTPushy/RCTPushyInternal.h']
  end

  # Conditionally add Expo subspec and check ExpoModulesCore version
  if valid_expo_project
    supports_bundle_url_final = false # Default

    expo_modules_core_version_str = expo_info['coreVersion'].to_s
    if !expo_modules_core_version_str.empty?
        begin
            # Compare versions using Gem::Version (handles trailing newline)
            installed_version = Gem::Version.new(expo_modules_core_version_str)
            target_version = Gem::Version.new('1.12.0')
            supports_bundle_url_final = installed_version >= target_version
        rescue ArgumentError
            # If Gem::Version fails parsing, supports_bundle_url_final remains false.
        end
    end

    s.subspec 'Expo' do |ss|
      ss.source_files = 'ios/Expo/**/*.{h,m,mm,swift}'
      if supports_bundle_url_final
        ss.pod_target_xcconfig = { 'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => 'EXPO_SUPPORTS_BUNDLEURL' }
      end
    end
  end

  # React Native >= 0.71 (react_native_pods.rb) wires codegen, the new
  # architecture and its dependencies.
  if defined?(install_modules_dependencies()) != nil
    install_modules_dependencies(s)
  end
end
