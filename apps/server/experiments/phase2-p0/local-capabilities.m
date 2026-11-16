#import <Foundation/Foundation.h>
#import <NaturalLanguage/NaturalLanguage.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>

// Captured by the experiment parent only, never log raw OCR or vectors.
static int emit(NSDictionary *value, int code) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  return code;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return emit(@{@"error": @"INVALID_MODE"}, 2);
    NSString *mode = @(argv[1]);
    NSString *path = @(argv[2]);
    if ([mode isEqualToString:@"embedding"]) {
      NLEmbedding *model = [NLEmbedding sentenceEmbeddingForLanguage:NLLanguageSimplifiedChinese];
      if (!model) return emit(@{@"available": @NO, @"reason": @"CHINESE_SENTENCE_MODEL_UNAVAILABLE"}, 2);
      NSData *data = [NSData dataWithContentsOfFile:path];
      NSArray *texts = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if (![texts isKindOfClass:[NSArray class]]) return emit(@{@"error": @"INPUT_INVALID"}, 3);
      NSMutableArray *vectors = [NSMutableArray array];
      for (NSString *text in texts) {
        NSArray *vector = [model vectorForString:text];
        if (!vector) return emit(@{@"error": @"EMBEDDING_UNAVAILABLE"}, 4);
        [vectors addObject:vector];
      }
      return emit(@{@"available": @YES, @"dimension": @(model.dimension), @"revision": @(model.revision), @"vectors": vectors}, 0);
    }
    if ([mode isEqualToString:@"ocr"]) {
      VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
      request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
      request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
      request.usesLanguageCorrection = NO;
      VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:[NSURL fileURLWithPath:path] options:@{}];
      NSError *error = nil;
      if (![handler performRequests:@[request] error:&error]) return emit(@{@"error": @"LOCAL_OCR_FAILED"}, 1);
      NSMutableArray *lines = [NSMutableArray array];
      for (VNRecognizedTextObservation *observation in request.results) {
        NSString *line = [observation topCandidates:1].firstObject.string;
        if (line) [lines addObject:line];
      }
      return emit(@{@"available": @YES, @"lines": lines}, 0);
    }
    if ([mode isEqualToString:@"fixtures"]) {
      NSArray *layouts = @[
        @[@"合成身体成分报告 A", @"测量日期 2026-10-01", @"体重 70.2 kg", @"体脂率 18.5 %", @"骨骼肌量 32.1 kg"],
        @[@"合成身体成分报告 B", @"2026-10-15", @"Weight 69.8 kg", @"Body Fat 18.0 %", @"Skeletal Muscle 32.3 kg"]
      ];
      for (NSUInteger layout = 0; layout < layouts.count; layout++) {
        NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(1200, 800)];
        [image lockFocus];
        [[NSColor whiteColor] setFill];
        NSRectFill(NSMakeRect(0, 0, 1200, 800));
        NSDictionary *attributes = @{NSFontAttributeName: [NSFont systemFontOfSize:38], NSForegroundColorAttributeName: [NSColor blackColor]};
        NSArray *lines = layouts[layout];
        for (NSUInteger i = 0; i < lines.count; i++) {
          [lines[i] drawAtPoint:NSMakePoint(layout == 1 && i > 1 ? 160 : 60, 690 - i * 110) withAttributes:attributes];
        }
        [image unlockFocus];
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSString *target = [path stringByAppendingPathComponent:[NSString stringWithFormat:@"report-%lu.png", (unsigned long)layout + 1]];
        if (!png || ![png writeToFile:target atomically:YES]) return emit(@{@"error": @"FIXTURE_FAILED"}, 5);
      }
      return emit(@{@"generated": @2}, 0);
    }
    return emit(@{@"error": @"INVALID_MODE"}, 2);
  }
}
