import AppKit
import Foundation
import WebKit

final class Harness: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var finished = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = WKUserContentController()
        controller.add(self, name: "metrics")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller

        let frame = NSRect(x: 0, y: 0, width: 1440, height: 1000)
        window = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Lodestory asset card WebKit regression"
        webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        webView.navigationDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else {
            fail("Missing fixture URL.")
            return
        }
        webView.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 35) { [weak self] in
            guard let self, !self.finished else { return }
            self.fail("Timed out waiting for WebKit layout metrics.")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let script = #"""
        (() => {
          const post = value => window.webkit.messageHandlers.metrics.postMessage(JSON.stringify(value));
          const waitFor = async predicate => {
            const deadline = performance.now() + 15000;
            while (performance.now() < deadline) {
              if (predicate()) return;
              await new Promise(resolve => setTimeout(resolve, 30));
            }
            throw new Error("Timed out waiting for fixture masonry layout.");
          };
          const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const snapshot = () => {
            const editor = document.querySelector(".asset-record-editor");
            const list = document.querySelector(".asset-object-cards");
            const rect = element => {
              const bounds = element.getBoundingClientRect();
              return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
                width: bounds.width, height: bounds.height};
            };
            const editorStyle = getComputedStyle(editor);
            const gridStyle = getComputedStyle(list);
            return {
              editor: {...rect(editor), clientWidth: editor.clientWidth, scrollWidth: editor.scrollWidth,
                paddingLeft: Number.parseFloat(editorStyle.paddingLeft), paddingRight: Number.parseFloat(editorStyle.paddingRight)},
              list: rect(list),
              grid: {tracks: gridStyle.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).map(Number.parseFloat),
                columnGap: Number.parseFloat(gridStyle.columnGap)},
              cards: [...list.children].map(card => ({id: card.dataset.cardId, ...rect(card)})),
            };
          };
          const run = async () => {
            await waitFor(() => window.__assetCardMasonryFixture
              && document.querySelector(".asset-object-cards")?.dataset.masonryReady === "true");
            await frames();
            const initial = snapshot();

            window.__assetCardMasonryFixture.setWidth(900);
            await waitFor(() => {
              const list = document.querySelector(".asset-object-cards");
              const tracks = getComputedStyle(list).gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
              const cards = [...list.children];
              return tracks.length === 2 && cards.length === 4;
            });
            await frames();
            post({initial, twoColumn: snapshot()});
          };
          run().catch(error => post({error: String(error?.stack || error)}));
        })()
        """#
        webView.evaluateJavaScript(script) { _, error in
            if let error { fputs("WebKit probe failed: \(error)\n", stderr) }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !finished, let json = message.body as? String else { return }
        finished = true
        print("LODESTORY_WK_METRICS:\(json)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
    }

    private func fail(_ message: String) {
        guard !finished else { return }
        finished = true
        fputs("\(message)\n", stderr)
        NSApp.terminate(nil)
        exit(1)
    }
}

let app = NSApplication.shared
let harness = Harness()
app.setActivationPolicy(.regular)
app.delegate = harness
app.run()
