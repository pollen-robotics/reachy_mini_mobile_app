#!/usr/bin/env ruby
# frozen_string_literal: true

# inject-frameworks.rb
# ────────────────────
# Patches the regenerated iOS xcodeproj to explicitly link
# additional system frameworks that Tauri's auto-generated project
# does not declare.
#
# Why this script exists
# ──────────────────────
# `tauri-plugin-auth-session` uses `ASWebAuthenticationSession` from
# Apple's AuthenticationServices framework. The crate's build.rs
# emits `cargo:rustc-link-lib=framework=AuthenticationServices` for
# `aarch64-apple-ios` (device) but NOT for `aarch64-apple-ios-sim`
# (simulator). As a result, the simulator build fails at link time
# with:
#   Undefined symbols for architecture arm64:
#     "_ASWebAuthenticationSessionErrorDomain", referenced from ...
#
# We declare the framework dependency at the xcodeproj level so that
# xcodebuild passes `-framework AuthenticationServices` to ld for
# every iOS target (device + simulator), regardless of what the
# Rust crate's build.rs emits. Linking a framework twice (here +
# crate-side for device) is harmless: ld de-duplicates.
#
# Idempotent: skips frameworks that are already linked.
#
# Usage
# ─────
#   ruby src-tauri/scripts/inject-frameworks.rb
#
# Optional env vars:
#   XCODEPROJ_PATH   override the path to the .xcodeproj
#   TARGET_NAME      override the target name to patch
#   FRAMEWORKS       comma-separated list of frameworks to link
#                    (default: AuthenticationServices)

require 'xcodeproj'

XCODEPROJ_PATH = ENV.fetch(
  'XCODEPROJ_PATH',
  File.expand_path(
    '../gen/apple/reachy_mini_mobile_app.xcodeproj',
    __dir__,
  ),
)
TARGET_NAME = ENV.fetch('TARGET_NAME', 'reachy_mini_mobile_app_iOS')
FRAMEWORKS = ENV
  .fetch('FRAMEWORKS', 'AuthenticationServices')
  .split(',')
  .map(&:strip)
  .reject(&:empty?)

unless File.directory?(XCODEPROJ_PATH)
  warn "[frameworks] xcodeproj not found at #{XCODEPROJ_PATH}"
  exit 1
end

project = Xcodeproj::Project.open(XCODEPROJ_PATH)

target = project.targets.find { |t| t.name == TARGET_NAME }
unless target
  warn "[frameworks] target '#{TARGET_NAME}' not found in xcodeproj"
  exit 1
end

frameworks_group = project.frameworks_group

FRAMEWORKS.each do |fw_name|
  fw_basename = fw_name.end_with?('.framework') ? fw_name : "#{fw_name}.framework"
  fw_sdk_path = "System/Library/Frameworks/#{fw_basename}"

  already_linked = target.frameworks_build_phase.files.any? do |bf|
    ref = bf.file_ref
    ref && (
      ref.path == fw_sdk_path ||
      ref.path == fw_basename ||
      ref.name == fw_basename
    )
  end

  if already_linked
    puts "[frameworks] #{fw_basename} already linked into #{TARGET_NAME}, skipping"
    next
  end

  file_ref = frameworks_group.files.find do |f|
    f.path == fw_sdk_path || f.path == fw_basename
  end

  if file_ref.nil?
    file_ref = frameworks_group.new_file(fw_sdk_path)
    file_ref.source_tree = 'SDKROOT'
    puts "[frameworks] created file ref for #{fw_sdk_path}"
  end

  target.frameworks_build_phase.add_file_reference(file_ref)
  puts "[frameworks] linked #{fw_basename} into #{TARGET_NAME}"
end

project.save
puts "[frameworks] xcodeproj saved at #{XCODEPROJ_PATH}"
