/**
 * MIT License
 *
 * Copyright (C) 2023 Huawei Device Co., Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

#include "PushyTurboModule.h"

using namespace rnoh;
using namespace facebook;

static jsi::Value _hostFunction_PushyTurboModule_setConfiguration(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"setConfiguration", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_requestAuthorization(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"requestAuthorization", args, count));
    }
    
static jsi::Value _hostFunction_PushyTurboModule_getCurrentPosition(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"getCurrentPosition", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_startObserving(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"startObserving", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_stopObserving(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"stopObserving", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_addListener(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"addListener", args, count));
    }

static jsi::Value _hostFunction_PushyTurboModule_removeListeners(
    jsi::Runtime &rt,
    react::TurboModule & turboModule,
    const jsi::Value* args,
    size_t count)
    {
        return jsi::Value(static_cast<ArkTSTurboModule &> (turboModule).call(rt,"removeListeners", args, count));
    }

PushyTurboModule::PushyTurboModule(const ArkTSTurboModule::Context ctx, const std::string name)
    : ArkTSTurboModule(ctx,name)
{
    methodMap_["setConfiguration"]= MethodMetadata{1, _hostFunction_PushyTurboModule_setConfiguration};
    methodMap_["requestAuthorization"]= MethodMetadata{2, _hostFunction_PushyTurboModule_requestAuthorization};
    methodMap_["getCurrentPosition"]= MethodMetadata{3, _hostFunction_PushyTurboModule_getCurrentPosition};
    methodMap_["startObserving"]= MethodMetadata{1, _hostFunction_PushyTurboModule_startObserving};
    methodMap_["stopObserving"]= MethodMetadata{0, _hostFunction_PushyTurboModule_stopObserving};
    methodMap_["addListener"]= MethodMetadata{1, _hostFunction_PushyTurboModule_addListener};
    methodMap_["removeListeners"]= MethodMetadata{1, _hostFunction_PushyTurboModule_removeListeners};
}