require "json"

# A documented module
module Greeter
  VERSION = "1.0"
  DEFAULT_NAME = "world"

  enum Mood
    Happy
    Sad = 5
  end

  abstract class Base
    abstract def greet(name : String) : String
  end

  class Hello < Base
    include Comparable(Hello)

    getter name : String
    property count = 0
    @@instances = 0

    def initialize(@name : String, times count : Int32 = 1)
      @@instances += 1
    end

    def greet(name : String) : String
      msg = "Hello, #{name.upcase} #{{a: 1}.size}!"
      total = 0
      [1, 2, 3].each do |n|
        total += n
      end
      puts msg, total
      msg
    end

    def self.build(name)
      new(name, 2)
    end

    macro define_thing(thing)
      def {{ thing.id }}
        {{ thing }}
      end
    end

    def <=>(other : Hello)
      name <=> other.name
    end
  end
end

text = <<-EOS
  heredoc "body" with #{1 + 1}
  EOS
pattern = /ab+c/i
words = %w[a b c]
sym = :symbol
x = 10 / 2
greeting = Greeter::Hello.new("a").greet("b")
puts "done"
