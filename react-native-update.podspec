require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = package['name']
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']

  s.authors      = package['author']
  s.homepage     = package['homepage']

  s.platform = :ios, "7.0"
  s.source = { :git => 'https://github.com/reactnativecn/react-native-pushy.git', :tag => '#{s.version}' }
  s.libraries = 'bz2', 'z'
  s.vendored_libraries = 'RCTHotUpdate/libRCTHotUpdate.a'
  s.pod_target_xcconfig = { 'USER_HEADER_SEARCH_PATHS' => '"$(SRCROOT)/../node_modules/react-native-update/ios"' }

  s.dependency 'React'

  s.subspec 'RCTHotUpdate' do |ss|
    ss.source_files = 'ios/RCTHotUpdate/*.{h,m}'
    ss.public_header_files = ['ios/RCTHotUpdate/RCTHotUpdate.h']
  end

  s.subspec 'SSZipArchive' do |ss|
    ss.source_files = 'ios/RCTHotUpdate/SSZipArchive/**/*.{h,m,c}'
    ss.private_header_files = 'ios/RCTHotUpdate/SSZipArchive/**/*.h'
  end

  s.subspec 'BSDiff' do |ss|
    ss.source_files = 'ios/RCTHotUpdate/BSDiff/**/*.{h,m,c}'
    ss.private_header_files = 'ios/RCTHotUpdate/BSDiff/**/*.h'
  end
end
