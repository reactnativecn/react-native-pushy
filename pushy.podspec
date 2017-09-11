
require 'json'
version = JSON.parse(File.read('package.json'))["version"]

Pod::Spec.new do |s|

  s.name           = "pushy"
  s.version        = version
  s.summary        = "React Native Hot Update"
  s.homepage       = "https://github.com/cqingwang/react-native-pushy"
  s.license        = "MIT"
  s.author         = { "reactnativecn" => "reactnativecn@reactnative.cn" }
  s.platform       = :ios, "7.0"
  s.source         = { :git => "https://github.com/cqingwang/react-native-pushy.git", :tag => "v#{s.version}" }
  s.source_files   = 'ios/**/*.{h,m,c}'
  s.library        = ['z', 'bz2.1.0']
  s.dependency 'React'

end
