import assert from "node:assert/strict";

describe("Lodestory desktop", () => {
  it("loads the welcome page and opens and closes the new project dialog", async () => {
    const heading = await $("#welcome-page-heading");
    await heading.waitForDisplayed({ timeout: 30000 });
    assert.equal(await heading.getText(), "欢迎使用 Lodestory");

    const create = await $("button*=开始新创作");
    await create.waitForEnabled({ timeout: 10000 });
    await create.click();
    const input = await $("input[name=projectName]");
    await input.waitForDisplayed();
    await input.setValue("自动测试小说");
    assert.equal(await input.getValue(), "自动测试小说");
    await $("button*=取消").click();
    await input.waitForDisplayed({ reverse: true });
    assert.equal(await heading.isDisplayed(), true);
  });
});
