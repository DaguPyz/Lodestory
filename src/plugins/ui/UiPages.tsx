import {useSyncExternalStore} from "react";
import type {UiService} from "@lodestory/sdk/ui";
import "./ui.css";

/** 通用根视图只读取页面登记与状态；不认识欢迎页、编辑页等业务组件。 */
export function UiPages({service}: {service: UiService}) {
    const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);

    return <div className="ui-pages">
        {snapshot.pages.map((page) => <div className="ui-page" key={page.id} hidden={!page.active}>
            {page.render({params: page.params, active: page.active})}
        </div>)}
    </div>;
}
