import {
  FluencyBuilderTimeRequestKey,
  FluencyBuilderValidationRequestKey,
  FoundationsCourseRequestKey,
  FoundationsTimeRequestKey,
} from "../lib/env.ts";
import { copyRequest, Request } from "../lib/request.ts";
import * as uuid from "jsr:@std/uuid";
import { getProduct, getTab, Product } from "../lib/product.ts";

export enum Feature {
  AddTime,
  ValidateLesson,
}

export interface Service {
  isFeatureReady(feature: Feature): Promise<boolean>;
  addTime(time: Date): Promise<void>;
  validateLesson(): Promise<void>;
}

async function getRequest(key: string): Promise<Request | undefined> {
  const req: Request | undefined = (await browser.storage.session.get(key))[
    key
  ];
  return req;
}

async function sendRequest(req: Request): Promise<void> {
  const tab = await getTab();

  const reqStr = JSON.stringify(req);
  await browser.scripting.executeScript({
    target: {
      tabId: tab.id,
    },
    args: [reqStr],
    func: async (reqStr: string) => {
      const req = JSON.parse(reqStr);
      await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    },
  });
}

export async function getService(): Promise<Service> {
  const product = await getProduct();

  console.debug(`Detected "${product}" product`);

  switch (product) {
    case Product.Foundations:
      return new FoundationsService();
    case Product.FluencyBuilder:
      return new FluencyBuilderService();
  }
}

export class FluencyBuilderService implements Service {
  async isFeatureReady(feature: Feature): Promise<boolean> {
    if (feature === Feature.ValidateLesson) {
      return (await getRequest(FluencyBuilderValidationRequestKey)) !== undefined;
    } else if (feature === Feature.AddTime) {
      const request = await getRequest(FluencyBuilderTimeRequestKey);
      if (request?.body == undefined) return false;

      // Check message is unskipped
      return JSON.parse(request.body).variables.messages.every(
        ({ skip }: { skip: boolean }) => !skip,
      );
    }
    return false;
  }

  async addTime(time: Date): Promise<void> {
    const req = await getRequest(FluencyBuilderTimeRequestKey);
    if (req === undefined || req.body === null)
      throw Error("Could not add time");

    const body = JSON.parse(req.body);
    for (let i = 0; i < body.variables.messages.length; i++) {
      const msg = body.variables.messages[i];
      msg.durationMs = Math.round(
        time.getTime() / body.variables.messages.length,
      );
      msg.activityAttemptId = uuid.v1.generate();
      msg.activityStepAttemptId = uuid.v1.generate();
    }
    req.body = JSON.stringify(body);

    console.debug("sending request", req);

    // needs to use this method, as the backend checks for the Origin
    // header which cannot manually be set.
    await sendRequest(req);

    console.debug("successfully sent request");
  }

  async validateLesson(): Promise<void> {
    const req = await getRequest(FluencyBuilderValidationRequestKey);
    if (req === undefined || req.body === null)
      throw Error("Could not validate lesson");

    console.debug("sending validation request", req);

    // For Fluency Builder, we need to send the captured GraphQL request
    // The request should already contain the proper lesson completion data
    await sendRequest(req);

    console.debug("successfully sent validation request");
  }
}

export class FoundationsService implements Service {
  /**
   * The maximum time a request can have
   */
  private maxTime = 1000 * 60 * 8;

  private createTimeRequest(base: Request, timeMs: number): Request {
    const res = copyRequest(base);
    const body = new DOMParser().parseFromString(res.body, "text/xml");
    const rootTag = body.documentElement.tagName;

    body.documentElement.getElementsByTagName("delta_time")[0].innerHTML =
      timeMs.toString();
    body.documentElement.getElementsByTagName("updated_at")[0].innerHTML =
      Date.now().toString();

    const editedBody = `<${rootTag}>${body.documentElement.innerHTML}</${rootTag}>`;
    res.body = editedBody;
    return res;
  }

  private getTimeRequests(base: Request, time: Date): Request[] {
    let remaining = time.getTime();
    const result: Request[] = [];
    while (remaining > this.maxTime) {
      result.push(this.createTimeRequest(base, this.maxTime));
      remaining -= this.maxTime;
    }

    if (remaining > 0) result.push(this.createTimeRequest(base, remaining));

    return result;
  }

  async addTime(time: Date): Promise<void> {
    const req = await getRequest(FoundationsTimeRequestKey);
    if (req === undefined) throw Error("Could not add time");

    const requests = this.getTimeRequests(req, time);

    console.debug("sending requests", requests);
    const promises = requests.map((req) => 
      fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      })
     );

    return await Promise.all(promises).then(() => {});
  }

  private async generateValidateRequests(req: Request): Promise<Request[]> {
    const res = await fetch(req.url, {
      method: "GET",
      headers: req.headers,
    });

    const body = new DOMParser().parseFromString(await res.text(), "text/xml");
    const requests: Request[] = [];

    const serializer = new XMLSerializer();

    for (const el of body.querySelectorAll("path_step_score")) {
      const challengeNumber = el.querySelector(
        "number_of_challenges",
      ).innerHTML;
      const correct = el.querySelector("score_correct");
      if (correct.innerHTML === challengeNumber) continue;

      correct.innerHTML = challengeNumber;

      const pathStep = el.querySelector("path_step_media_id").innerHTML;
      if (!pathStep) continue;

      const url =
        req.url +
        "&" +
        new URLSearchParams({
          _method: "put",
          path_step_media_id: pathStep,
        });

      const bodyString: string = serializer.serializeToString(el);
      requests.push({
        url,
        method: "POST",
        headers: req.headers,
        body: bodyString,
        timestamp: new Date(),
        requestId: "-1",
        tabId: -1,
      });
    }

    return requests;
  }

  async isFeatureReady(feature: Feature): Promise<boolean> {
    if (feature === Feature.ValidateLesson) {
      return (await getRequest(FoundationsCourseRequestKey)) !== undefined;
    } else if (feature === Feature.AddTime) {
      return (await getRequest(FoundationsTimeRequestKey)) !== undefined;
    }
    return false;
  }

  async validateLesson(): Promise<void> {
    const req = await getRequest(FoundationsCourseRequestKey);
    if (req === undefined) throw Error("Could not add time");

    const requests = await this.generateValidateRequests(req);

    await Promise.all(
      requests.map(({ url, body, headers }) =>
        fetch(url, {
          method: "POST",
          body,
          headers,
        }),
      ),
    );
  }
}
