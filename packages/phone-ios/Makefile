SCHEME := EnsoCodePhone
PROJECT := EnsoCodePhone.xcodeproj
DEST ?= platform=iOS Simulator,name=iPhone 17
CONFIG ?= Debug
DERIVED := build

.PHONY: project open build test run archive clean

project:
	xcodegen generate

open: project
	open $(PROJECT)

build: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DEST)' -configuration $(CONFIG) -derivedDataPath $(DERIVED) build

test: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DEST)' -configuration Debug -derivedDataPath $(DERIVED) test

run: build
	xcrun simctl boot "iPhone 17" || true
	xcrun simctl install booted $(DERIVED)/Build/Products/$(CONFIG)-iphonesimulator/EnsoCode.app
	xcrun simctl launch booted com.j3n5en.enso-code.phone

archive: project
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Release -destination 'generic/platform=iOS' -archivePath build/EnsoCode.xcarchive archive
	@echo "Archive: build/EnsoCode.xcarchive"
	@echo "在 Xcode 中打开 Archive，选择 Distribute App 即可导出 Ad Hoc / App Store / 开发包。"

clean:
	rm -rf build DerivedData
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) clean || true
