import Foundation
import UserNotifications

func argumentValue(after flag: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: flag) else { return nil }
    let valueIndex = arguments.index(after: index)
    guard valueIndex < arguments.count else { return nil }
    return arguments[valueIndex]
}

func openVisualStudioCode() {
    let bundleIDs = ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"]
    for bundleID in bundleIDs {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-b", bundleID]
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            continue
        }
        if process.terminationStatus == 0 {
            return
        }
    }
    let fallback = Process()
    fallback.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    fallback.arguments = ["-a", "Visual Studio Code"]
    try? fallback.run()
}

let arguments = CommandLine.arguments

if !arguments.contains("--title") && !arguments.contains("--body") {
    openVisualStudioCode()
    exit(0)
}

let title = argumentValue(after: "--title", in: arguments) ?? "Opencodex"
let body = argumentValue(after: "--body", in: arguments) ?? ""

let semaphore = DispatchSemaphore(value: 0)
let center = UNUserNotificationCenter.current()
var authorized = false

func deliver() {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(
        identifier: UUID().uuidString,
        content: content,
        trigger: nil
    )
    center.add(request) { _ in
        semaphore.signal()
    }
}

center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
    authorized = granted
    if granted {
        deliver()
    } else {
        semaphore.signal()
    }
}

semaphore.wait()
exit(authorized ? 0 : 1)
